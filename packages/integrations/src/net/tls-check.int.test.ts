import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { httpCheck } from "@galena/contracts";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, expect, test } from "vitest";
import { checkHttp } from "./http-check.ts";
import { createGuard } from "./ssrf.ts";

// A throwaway CA and certificates made by openssl when the test starts; no key material is
// committed. The CA is trusted for this process only, the way a public CA is in production.
const certificates = `
set -e
mkdir -p /out && cd /out
key() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1.key" 2>/dev/null; }
leaf() {
  name=$1; host=$2; shift 2
  key "$name"
  openssl req -new -key "$name.key" -subj "/CN=$host" -out "$name.csr"
  printf 'subjectAltName=DNS:%s\\n' "$host" > "$name.ext"
  openssl x509 -req -in "$name.csr" -CA ca.crt -CAkey ca.key -extfile "$name.ext" -out "$name.crt" "$@" 2>/dev/null
}
key ca
openssl req -x509 -key ca.key -subj "/CN=Galena test CA" -days 1 -out ca.crt
leaf valid local.test -days 1
leaf expired local.test -not_before 20200101000000Z -not_after 20200102000000Z
leaf wrong-host elsewhere.test -days 1
key self-signed
openssl req -x509 -key self-signed.key -subj "/CN=local.test" -addext "subjectAltName=DNS:local.test" -days 1 -out self-signed.crt
`;

const testGuard = createGuard({
  allowAddresses: ["127.0.0.1"],
  resolve: (_hostname, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]),
});
const defaultCAs = getCACertificates("default");
let container: StartedTestContainer;
const servers: Server[] = [];
const ports = new Map<string, number>();

async function run(command: string) {
  const { exitCode, stdout, stderr } = await container.exec(["sh", "-c", command]);
  if (exitCode !== 0) throw new Error(`openssl failed: ${stderr}`);
  return stdout;
}

beforeAll(async () => {
  container = await new GenericContainer("alpine/openssl:3.5.8")
    .withEntrypoint(["sleep"])
    .withCommand(["600"])
    .start();
  await run(certificates);
  setDefaultCACertificates([...defaultCAs, await run("cat /out/ca.crt")]);
  for (const name of ["valid", "expired", "wrong-host", "self-signed"]) {
    const server = createServer(
      { key: await run(`cat /out/${name}.key`), cert: await run(`cat /out/${name}.crt`) },
      (_req, res) => res.end("ok"),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    ports.set(name, (server.address() as AddressInfo).port);
  }
});
afterAll(async () => {
  setDefaultCACertificates(defaultCAs);
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  await container?.stop();
});

const checkAgainst = (name: string) =>
  checkHttp(httpCheck.parse({ url: `https://local.test:${ports.get(name)}/` }), testGuard);

test("a certificate from a trusted CA is up, with the TLS handshake timed", async () => {
  const outcome = await checkAgainst("valid");
  expect(outcome).toMatchObject({ status: "up", httpStatus: 200, error: null });
  expect(outcome.phases?.tls).toBeTypeOf("number");
  expect(outcome.phases?.tls).toBeGreaterThanOrEqual(0);
});

test.each([
  ["expired", "CERT_HAS_EXPIRED"],
  ["self-signed", "DEPTH_ZERO_SELF_SIGNED_CERT"],
  ["wrong-host", "ERR_TLS_CERT_ALTNAME_INVALID"],
])("the %s certificate is down with tls_failed", async (name, reason) => {
  const outcome = await checkAgainst(name);
  expect(outcome).toMatchObject({
    status: "down",
    httpStatus: null,
    phases: null,
    error: { code: "tls_failed", message: `The TLS handshake failed (${reason}).` },
  });
});

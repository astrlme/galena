import { createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";

// Runs on deploy, as the Api stack's custom resource for the internal page's signing key. The
// first deploy makes the pair and keeps the private half; later ones hand back the public half of
// the same key, because CloudFront can't change a public key in place. It never deletes the key:
// CloudFormation deletes a replaced resource after making its successor, which may have found it.

/** Where the private key lives: an SSM SecureString in AWS. */
export type KeyStore = {
  read: (name: string) => Promise<string | undefined>;
  create: (name: string, privateKey: string) => Promise<void>;
};

type KeyEvent =
  | { RequestType: "Create" | "Update"; ResourceProperties: { ParameterName: string } }
  | {
      RequestType: "Delete";
      PhysicalResourceId: string;
      ResourceProperties: { ParameterName: string };
    };

export function keyMaker(store: KeyStore) {
  return async (event: KeyEvent) => {
    if (event.RequestType === "Delete") return { PhysicalResourceId: event.PhysicalResourceId };
    const name = event.ResourceProperties.ParameterName;
    let privateKey = await store.read(name);
    if (!privateKey) {
      if (event.RequestType === "Update") {
        throw new Error(
          `${name} is gone, and CloudFront can't take a new public key in place. Raise pageKeyGeneration in the deployment's config, then deploy.`,
        );
      }
      privateKey = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey;
      await store.create(name, privateKey);
    }
    const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" });
    return { PhysicalResourceId: name, Data: { PublicKey: publicKey.toString() } };
  };
}

const ssm = new SSMClient({});
export const handler = keyMaker({
  read: (name) =>
    ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true })).then(
      (response) => response.Parameter?.Value,
      (error: unknown) => {
        if (error instanceof ParameterNotFound) return undefined;
        throw error;
      },
    ),
  create: async (name, privateKey) => {
    await ssm.send(
      new PutParameterCommand({ Name: name, Value: privateKey, Type: "SecureString" }),
    );
  },
});

import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import {
  OidcProviderNative,
  PolicyStatement,
  Role,
  WebIdentityPrincipal,
} from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { type StageConfig, stageRegions } from "../config/stages.ts";

const GITHUB_OIDC = "token.actions.githubusercontent.com";
// Bootstrap roles `cdk deploy` assumes. Image publishing is left out: no stack builds Docker images.
const BOOTSTRAP_ROLES = ["deploy", "file-publishing", "lookup"];

/** Lets GitHub Actions on the deploy ref run `cdk deploy`, and nothing else. */
export class CiAccessStack extends Stack {
  readonly deployRole: Role;

  constructor(scope: Construct, id: string, props: StackProps & { config: StageConfig }) {
    super(scope, id, props);
    const { stage, github } = props.config;

    const provider = new OidcProviderNative(this, "GitHubOidc", {
      url: `https://${GITHUB_OIDC}`,
      clientIds: ["sts.amazonaws.com"],
    });

    this.deployRole = new Role(this, "DeployRole", {
      roleName: `galena-${stage}-github-deploy`,
      description: `GitHub Actions on ${github.repository} ${github.deployRef} deploying Galena ${stage}`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          [`${GITHUB_OIDC}:aud`]: "sts.amazonaws.com",
          [`${GITHUB_OIDC}:sub`]: `repo:${github.repository}:ref:${github.deployRef}`,
        },
      }),
    });

    // cdk deploy works by assuming the bootstrap roles; the deploy role needs nothing more.
    this.deployRole.addToPolicy(
      new PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: stageRegions(props.config).flatMap((region) =>
          BOOTSTRAP_ROLES.map(
            (role) =>
              `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-${role}-role-${this.account}-${region}`,
          ),
        ),
      }),
    );
  }
}

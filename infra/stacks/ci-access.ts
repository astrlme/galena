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

// The GitHub environment the Deploy workflow's deploy job runs in. Its required reviewers and
// branch rule decide who may deploy; a fork that sets none gets an environment without them.
export const DEPLOY_ENVIRONMENT = "deploy";

/**
 * Lets GitHub Actions deploy, and nothing else: the deploy job, in its environment, runs
 * `cdk deploy`; any job on the deploy ref may ask the lookup role what synth needs to know.
 */
export class CiAccessStack extends Stack {
  readonly deployRole: Role;

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & {
      config: StageConfig & { github: NonNullable<StageConfig["github"]> };
    },
  ) {
    super(scope, id, props);
    const { stage, github } = props.config;

    const provider = new OidcProviderNative(this, "GitHubOidc", {
      url: `https://${GITHUB_OIDC}`,
      clientIds: ["sts.amazonaws.com"],
    });

    const trusted = (...subjects: string[]) =>
      new WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          [`${GITHUB_OIDC}:aud`]: "sts.amazonaws.com",
          [`${GITHUB_OIDC}:sub`]: subjects.map((subject) => `${github.oidcSubject}:${subject}`),
        },
      });
    const onDeployRef = `ref:${github.deployRef}`;
    const bootstrapRole = (role: string, region: string) =>
      `arn:${this.partition}:iam::${this.account}:role/cdk-hnb659fds-${role}-role-${this.account}-${region}`;

    this.deployRole = new Role(this, "DeployRole", {
      roleName: `galena-${stage}-github-deploy`,
      description: `GitHub Actions on ${github.repository} ${github.deployRef} deploying Galena ${stage}`,
      maxSessionDuration: Duration.hours(1),
      // A job in an environment presents the environment as its subject, not the ref.
      assumedBy: trusted(onDeployRef, `environment:${DEPLOY_ENVIRONMENT}`),
    });

    // cdk deploy works by assuming the bootstrap roles; the deploy role needs nothing more.
    this.deployRole.addToPolicy(
      new PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: stageRegions(props.config).flatMap((region) =>
          BOOTSTRAP_ROLES.map((role) => bootstrapRole(role, region)),
        ),
      }),
    );

    // Synth asks AWS for the home region's availability zones. The job that fetches them runs
    // outside the environment, so it gets a role that can read and never change anything.
    const lookupRole = new Role(this, "LookupRole", {
      roleName: `galena-${stage}-github-lookup`,
      description: `GitHub Actions on ${github.repository} ${github.deployRef} reading what synth looks up`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: trusted(onDeployRef),
    });
    lookupRole.addToPolicy(
      new PolicyStatement({
        actions: ["sts:AssumeRole"],
        resources: [bootstrapRole("lookup", props.config.homeRegion)],
      }),
    );
  }
}

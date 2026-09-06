/**
 * SSM Parameter Store paths for cross-stack, late-bound references.
 *
 * SharedStack and the Accounts stack *write* these; every other service stack
 * *reads* them via `StringParameter.valueForStringParameter`. Using SSM instead
 * of CloudFormation exports keeps the per-service stacks independently
 * deployable and avoids cross-stack "deadly embrace" on teardown.
 */
export const SSM_PREFIX = '/cre-portal';

export const Param = {
  // Written by SharedStack (Module 2)
  busName: `${SSM_PREFIX}/shared/bus-name`,
  busArn: `${SSM_PREFIX}/shared/bus-arn`,
  httpApiId: `${SSM_PREFIX}/shared/http-api-id`,
  httpApiEndpoint: `${SSM_PREFIX}/shared/http-api-endpoint`,
  webBucketName: `${SSM_PREFIX}/shared/web-bucket-name`,
  distributionId: `${SSM_PREFIX}/shared/distribution-id`,
  distributionDomain: `${SSM_PREFIX}/shared/distribution-domain`,

  // Written by the Accounts stack (Module 3). Every service stack creates its
  // own HttpJwtAuthorizer from the issuer + client id below (identical config,
  // so no need to share one authorizer resource across stacks).
  userPoolId: `${SSM_PREFIX}/accounts/user-pool-id`,
  userPoolClientId: `${SSM_PREFIX}/accounts/user-pool-client-id`,
  userPoolIssuer: `${SSM_PREFIX}/accounts/user-pool-issuer-url`,
  hostedUiDomain: `${SSM_PREFIX}/accounts/hosted-ui-domain`,
} as const;

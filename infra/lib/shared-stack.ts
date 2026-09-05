import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

/**
 * SharedStack — cross-service infrastructure.
 *
 * Module 1: empty shell (synthesizes cleanly).
 * Module 2 adds: the EventBridge custom bus `cre-portal-bus`, the single
 * API Gateway HTTP API + Cognito JWT authorizer, the Cognito user pool +
 * app client + hosted-UI domain, SES identities, and the SPA's S3 bucket +
 * CloudFront distribution. Per-service stacks depend on this one.
 */
export class SharedStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, {
      ...props,
      description: 'CRE Transaction Portal — shared infrastructure (bus, edge API, auth, web hosting)',
    });
  }
}

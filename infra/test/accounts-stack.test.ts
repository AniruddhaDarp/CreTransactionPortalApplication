import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, it } from 'vitest';
import { AccountsStack } from '../lib/accounts-stack.js';

let t: Template;

beforeAll(() => {
  // Skip esbuild asset bundling — we only assert on the CloudFormation shape.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new AccountsStack(app, 'TestAccounts', {
    env: { account: '111111111111', region: 'us-east-2' },
  });
  t = Template.fromStack(stack);
});

describe('AccountsStack', () => {
  it('creates the accounts table with an email GSI', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: Match.arrayWith([
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ]),
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'gsi-email' }),
      ]),
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('creates a self-sign-up user pool with a public SPA client using auth-code + PKCE', () => {
    t.resourceCountIs('AWS::Cognito::UserPool', 1);
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false },
      AutoVerifiedAttributes: ['email'],
    });
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthScopes: Match.arrayWith(['openid', 'email', 'profile']),
      PreventUserExistenceErrors: 'ENABLED',
    });
    t.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  });

  it('wires the post-confirmation trigger to a Lambda', () => {
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: { PostConfirmation: Match.anyValue() },
    });
  });

  it('runs the service Lambdas on arm64 nodejs22 with X-Ray active', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
    });
  });

  it('adds JWT-authorized GET and PUT routes for /v1/me', () => {
    t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT' });
    for (const rk of ['GET /v1/me', 'PUT /v1/me']) {
      t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: rk,
        AuthorizationType: 'JWT',
      });
    }
  });

  it('publishes the four accounts SSM parameters', () => {
    t.resourceCountIs('AWS::SSM::Parameter', 4);
  });
});

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, it } from 'vitest';
import { DealsStack } from '../lib/deals-stack.js';

let t: Template;

beforeAll(() => {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  t = Template.fromStack(
    new DealsStack(app, 'TestDeals', { env: { account: '111111111111', region: 'us-east-2' } }),
  );
});

describe('DealsStack', () => {
  it('creates the deals table with gsi1 (by user) and gsi2 (by email)', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'gsi1' }),
        Match.objectLike({ IndexName: 'gsi2' }),
      ]),
    });
  });

  it('runs one arm64 nodejs22 Lambda with X-Ray active', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
    });
  });

  it('registers all 14 JWT-authorized routes', () => {
    t.resourceCountIs('AWS::ApiGatewayV2::Route', 14);
    t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT' });
    for (const rk of [
      'POST /v1/deals',
      'GET /v1/deals/{dealId}',
      'POST /v1/deals/{dealId}/invites',
      'POST /v1/deals/{dealId}/invites/{token}/accept',
      'DELETE /v1/deals/{dealId}/members/{userId}',
    ]) {
      t.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: rk,
        AuthorizationType: 'JWT',
      });
    }
  });
});

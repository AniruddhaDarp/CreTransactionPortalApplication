import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, it } from 'vitest';
import { ChatStack } from '../lib/chat-stack.js';

let t: Template;

beforeAll(() => {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  t = Template.fromStack(
    new ChatStack(app, 'TestChat', { env: { account: '111111111111', region: 'us-east-2' } }),
  );
});

describe('ChatStack', () => {
  it('has a chat table with TTL enabled', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });

  it('runs its Lambdas on nodejs22/arm64 with X-Ray active', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
    });
  });

  it('routes member.* + system events from the bus into an SQS queue with a DLQ', () => {
    t.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['cre.deals'],
        'detail-type': Match.arrayWith(['member.joined', 'stage.advanced', 'deal.status_changed']),
      },
    });
    t.resourceCountIs('AWS::SQS::Queue', 2); // consumer queue + DLQ
    t.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: { maxReceiveCount: 5 },
    });
  });

  it('wires the queue as an event source for the consumer with partial-batch responses', () => {
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('registers the 11 JWT-authorized chat routes', () => {
    t.resourceCountIs('AWS::ApiGatewayV2::Route', 11);
    t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT' });
    for (const rk of [
      'POST /v1/deals/{dealId}/threads',
      'GET /v1/deals/{dealId}/threads/{threadId}/messages',
      'GET /v1/deals/{dealId}/activity',
    ]) {
      t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: rk, AuthorizationType: 'JWT' });
    }
  });
});

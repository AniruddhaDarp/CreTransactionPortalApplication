import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, it } from 'vitest';
import { NotificationsStack } from '../lib/notifications-stack.js';

let t: Template;

beforeAll(() => {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  t = Template.fromStack(
    new NotificationsStack(app, 'TestNotifications', {
      env: { account: '111111111111', region: 'us-east-2' },
    }),
  );
});

describe('NotificationsStack', () => {
  it('creates a pay-per-request table with TTL', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
    });
  });

  it('subscribes to the relevant events by detail-type (across sources)', () => {
    const rules = t.findResources('AWS::Events::Rule');
    const patterns = Object.values(rules).map((r) => r.Properties.EventPattern);
    const types: string[] = patterns.flatMap((p) => p['detail-type'] ?? []);
    for (const want of ['handshake.requested', 'message.posted', 'stage.advanced', 'member.invited', 'account.created']) {
      if (!types.includes(want)) throw new Error(`rule does not subscribe to ${want}`);
    }
  });

  it('has an SES send grant (inert until NOTIFY_EMAIL_FROM is set)', () => {
    const policies = t.findResources('AWS::IAM::Policy');
    const hasSes = Object.values(policies).some((p) =>
      (p.Properties.PolicyDocument.Statement as Array<{ Action: unknown }>).some(
        (s) => s.Action === 'ses:SendEmail',
      ),
    );
    if (!hasSes) throw new Error('expected an ses:SendEmail statement on a role policy');
  });

  it('routes the queue into the consumer with partial-batch responses + a DLQ', () => {
    t.resourceCountIs('AWS::SQS::Queue', 2);
    t.hasResourceProperties('AWS::SQS::Queue', { RedrivePolicy: { maxReceiveCount: 5 } });
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('runs its Lambdas on nodejs22/arm64 with X-Ray active', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      TracingConfig: { Mode: 'Active' },
    });
  });

  it('registers the 2 JWT-authorized notification routes', () => {
    t.resourceCountIs('AWS::ApiGatewayV2::Route', 2);
    t.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', { AuthorizerType: 'JWT' });
    for (const rk of ['GET /v1/notifications', 'POST /v1/notifications/read']) {
      t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: rk, AuthorizationType: 'JWT' });
    }
  });
});

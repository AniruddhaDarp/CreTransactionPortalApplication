#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { AccountsStack } from '../lib/accounts-stack.js';
import { ChatStack } from '../lib/chat-stack.js';
import { DealsStack } from '../lib/deals-stack.js';
import { DocumentsStack } from '../lib/documents-stack.js';
import { SharedStack } from '../lib/shared-stack.js';

const app = new App();

// Pinned to the AWS project account + its selected Region. All regional
// resources must live here; CloudFront is global.
const env = {
  account: process.env.CDK_DEPLOY_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT ?? '581759697181',
  region: process.env.CDK_DEPLOY_REGION ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-2',
};

const shared = new SharedStack(app, 'CrePortalShared', { env });

const accounts = new AccountsStack(app, 'CrePortalAccounts', { env });
// Accounts reads SharedStack's SSM parameters at deploy time; make the ordering
// explicit for `cdk deploy --all`.
accounts.addStackDependency(shared, 'reads /cre-portal/shared/* SSM parameters');

const deals = new DealsStack(app, 'CrePortalDeals', { env });
deals.addStackDependency(shared, 'reads /cre-portal/shared/* SSM parameters');
deals.addStackDependency(accounts, 'reads /cre-portal/accounts/* SSM parameters (JWT authorizer)');

const chat = new ChatStack(app, 'CrePortalChat', { env });
chat.addStackDependency(shared, 'reads /cre-portal/shared/* SSM parameters + the bus');
chat.addStackDependency(accounts, 'reads /cre-portal/accounts/* SSM parameters (JWT authorizer)');

const documents = new DocumentsStack(app, 'CrePortalDocuments', { env });
documents.addStackDependency(shared, 'reads /cre-portal/shared/* SSM parameters + the bus');
documents.addStackDependency(
  accounts,
  'reads /cre-portal/accounts/* SSM parameters (JWT authorizer)',
);

#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { SharedStack } from '../lib/shared-stack.js';

const app = new App();

// Pinned to the AWS project account + its selected Region. All regional
// resources must live here; CloudFront (added in Module 2) is global.
const env = {
  account: process.env.CDK_DEPLOY_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT ?? '581759697181',
  region: process.env.CDK_DEPLOY_REGION ?? process.env.CDK_DEFAULT_REGION ?? 'us-east-2',
};

new SharedStack(app, 'CrePortalShared', { env });

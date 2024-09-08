#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LambdaPublicEcrGalleryStack } from '../lib/lambda-public-ecr-gallery-stack';

const app = new cdk.App();
new LambdaPublicEcrGalleryStack(app, 'LambdaPublicEcrGalleryStack');

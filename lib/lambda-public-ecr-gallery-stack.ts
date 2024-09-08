import * as path from "path";
import {
  Aws,
  Stack,
  Duration,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_ecr as ecr,
  aws_codebuild as codebuild,
  custom_resources as cr
} from "aws-cdk-lib";
import { Construct } from "constructs";

const PUBLIC_ECR_GALLERY_IMAGE_REGISTRY =
  "public.ecr.aws/aws-gcr-solutions/medical-insight/connector-serp";

const PUBLIC_ECR_GALLERY_IMAGE_TAG = "03349a4a";

export class LambdaPublicEcrGalleryStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Create an ECR repository for the private image
    const connectorRepo = new ecr.Repository(this, "PrivateRepo");

    // Create a role for CodeBuild to use for permissions
    const codeBuildRole = new iam.Role(this, "CodeBuildRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "AmazonEC2ContainerRegistryFullAccess"
        ),
        iam.ManagedPolicy.fromAwsManagedPolicyName("CloudWatchLogsFullAccess")
      ]
    });

    // Create a CodeBuild project to pull from public ECR and push to private ECR,
    // because the Lambda function can't pull from public ECR
    const codeBuildProject = new codebuild.Project(
      this,
      "MirrorImageCodeBuild",
      {
        role: codeBuildRole,
        environment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          privileged: true
        },
        buildSpec: codebuild.BuildSpec.fromObject({
          version: "0.2",
          phases: {
            install: {
              commands: [
                'echo "Starting install phase..."',
                'echo "No installation commands required."'
              ]
            },
            pre_build: {
              commands: [
                'echo "Authenticating to private ECR"',
                "aws sts get-caller-identity",
                "export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)",
                `echo "Detecting region and setting ECR suffix"`,
                `if [ "\${AWS_DEFAULT_REGION#cn}" != "\${AWS_DEFAULT_REGION}" ]; then
                   export ECR_URL_SUFFIX=".cn"
                 else
                   export ECR_URL_SUFFIX=""
                 fi`,
                `aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com$ECR_URL_SUFFIX`
              ]
            },
            build: {
              commands: [
                `echo "Pulling image from public ECR: ${PUBLIC_ECR_GALLERY_IMAGE_REGISTRY}:${PUBLIC_ECR_GALLERY_IMAGE_TAG}"`,
                `docker pull ${PUBLIC_ECR_GALLERY_IMAGE_REGISTRY}:${PUBLIC_ECR_GALLERY_IMAGE_TAG}`,
                `echo "Tagging image for private ECR"`,
                `docker tag ${PUBLIC_ECR_GALLERY_IMAGE_REGISTRY}:${PUBLIC_ECR_GALLERY_IMAGE_TAG} ${connectorRepo.repositoryUri}:${PUBLIC_ECR_GALLERY_IMAGE_TAG}`,
                `echo "Pushing image to private ECR: ${connectorRepo.repositoryUri}:${PUBLIC_ECR_GALLERY_IMAGE_TAG}"`,
                `docker push ${connectorRepo.repositoryUri}:${PUBLIC_ECR_GALLERY_IMAGE_TAG}`
              ]
            },
            post_build: {
              commands: [
                `echo "Image successfully pushed to private ECR: ${connectorRepo.repositoryUri}:${PUBLIC_ECR_GALLERY_IMAGE_TAG}"`
              ]
            }
          }
        })
      }
    );

    const triggerCodeBuildLambda = new lambda.Function(
      this,
      "TriggerCodeBuildLambda",
      {
        description: `${Aws.STACK_NAME} - Trigger CodeBuild Lambda`,
        runtime: lambda.Runtime.PYTHON_3_11,
        handler: "lambda_function.lambda_handler",
        timeout: Duration.minutes(15),
        memorySize: 128,
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../lambda/trigger-codebuild")
        ),
        environment: {
          CODEBUILD_PROJECT_NAME: codeBuildProject.projectName
        }
      }
    );
    triggerCodeBuildLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"],
        resources: [codeBuildProject.projectArn]
      })
    );

    const triggerCodeBuildCustomResource = new cr.AwsCustomResource(
      this,
      "TriggerCodeBuildCustomResource",
      {
        onCreate: {
          service: "Lambda",
          action: "invoke",
          parameters: {
            FunctionName: triggerCodeBuildLambda.functionName
          },
          physicalResourceId: cr.PhysicalResourceId.of(Date.now().toString())
        },
        onUpdate: {
          service: "Lambda",
          action: "invoke",
          parameters: {
            FunctionName: triggerCodeBuildLambda.functionName
          },
          physicalResourceId: cr.PhysicalResourceId.of(Date.now().toString())
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ["lambda:InvokeFunction"],
            resources: [triggerCodeBuildLambda.functionArn]
          }),
          new iam.PolicyStatement({
            actions: ["codebuild:StartBuild"],
            resources: [codeBuildProject.projectArn]
          })
        ])
      }
    );

    const connector = new lambda.DockerImageFunction(this, "connector", {
      code: lambda.DockerImageCode.fromEcr(connectorRepo, {
        tagOrDigest: PUBLIC_ECR_GALLERY_IMAGE_TAG
      }),
      memorySize: 4096,
      timeout: Duration.minutes(15),
      description: `${Aws.STACK_NAME} - Main Lambda`
    });
    connector.node.addDependency(triggerCodeBuildCustomResource); // Ensure the Lambda function is created after the image is pushed
  }
}

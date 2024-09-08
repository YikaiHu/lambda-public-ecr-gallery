import boto3
import os
import time

codebuild = boto3.client("codebuild")


def lambda_handler(event, context):
    project_name = os.getenv("CODEBUILD_PROJECT_NAME")

    try:
        # Start the CodeBuild project
        response = codebuild.start_build(projectName=project_name)
        build_id = response["build"]["id"]
        print(f"CodeBuild started with build ID: {build_id}")

        # Poll CodeBuild until completion
        while True:
            build_status = get_build_status(build_id)
            if build_status in ["SUCCEEDED", "FAILED", "STOPPED"]:
                print(f"CodeBuild finished with status: {build_status}")
                if build_status == "SUCCEEDED":
                    return {
                        "statusCode": 200,
                        "body": f"CodeBuild completed successfully: {build_id}",
                    }
                else:
                    raise Exception(f"CodeBuild failed with status: {build_status}")

            time.sleep(10)

    except Exception as e:
        print(f"Error during CodeBuild execution: {str(e)}")
        return {
            "statusCode": 500,
            "body": f"Error during CodeBuild execution: {str(e)}",
        }


def get_build_status(build_id):
    response = codebuild.batch_get_builds(ids=[build_id])
    build_info = response["builds"][0]
    return build_info["buildStatus"]

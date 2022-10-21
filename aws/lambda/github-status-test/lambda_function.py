# Copyright (c) 2019-present, Facebook, Inc.

import gzip
import json
import os
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

import boto3

s3 = boto3.resource("s3")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
BUCKET_NAME = "ossci-raw-job-status"


def json_dumps(obj):
    return json.dumps(obj, sort_keys=True, indent=4, separators=(",", ": "))


def download_log(conclusion, id):
    url = f"https://api.github.com/repos/pytorch/pytorch/actions/jobs/{id}/logs"
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "Authorization": f"token {GITHUB_TOKEN}",
    }
    with urlopen(Request(url, headers=headers)) as data:
        log_data = data.read()

    # Note: brotli would compress better, but is annoying to add as a dep
    # If space becomes a problem it's roughly ~2x better in TEXT_MODE
    s3.Object(BUCKET_NAME, f"log/{id}").put(
        Body=gzip.compress(log_data),
        ContentType="text/plain",
        ContentEncoding="gzip",
        Metadata={"conclusion": conclusion},
    )

    # Fire off to the `log_classifier` lambda
    urlopen(
        f"https://vwg52br27lx5oymv4ouejwf4re0akoeg.lambda-url.us-east-1.on.aws/?job_id={id}"
    )


# See this page for webhook info:
# https://docs.github.com/en/developers/webhooks-and-events/webhook-events-and-payloads
def lambda_handler(event, context):
    event_type = event["headers"]["X-GitHub-Event"]
    body = json.loads(event["body"])

    if (
        event_type == "workflow_job"
        and body["action"] == "completed"
        and body["repository"]["full_name"] == "pytorch/pytorch"
    ):
        try:
            download_log(body[event_type]["conclusion"], body[event_type]["id"])
        except HTTPError as err:
            # Just eat the error as logs are optional.
            print("ERROR", err)
            pass

    if event_type == "workflow_job" or event_type == "workflow_run":
        obj = body[event_type]
        repo = body["repository"]["full_name"]

        # Here we intentionally don't generate a uuid so that webhook payloads
        # that map to a single payload overwrite each other, which gives us the
        # behavior that the object always represents the latest state of a job.
        #
        # However, this means that there is the chance that job ids from
        # different repos could collide. To prevent this, prefix the objects
        # generated by non-pytorch repos (we could prefix pytorch objects as
        # well, but too lazy to do the data migration).
        if repo == "pytorch/pytorch":
            repo_prefix = ""
        else:
            repo_prefix = repo + "/"
        s3.Object(BUCKET_NAME, f"{event_type}/{repo_prefix}{obj['id']}").put(
            Body=json_dumps(obj), ContentType="application/json"
        )

        # For testing, dump the whole thing
        obj = body
        s3.Object(BUCKET_NAME, f"full_{event_type}/{uuid4()}").put(
            Body=json_dumps(obj), ContentType="application/json"
        )

        return {"statusCode": 200, "body": f"{event_type} processed: {obj}"}

    s3.Object(BUCKET_NAME, f"{event_type}/{uuid4()}").put(
        Body=json_dumps(body), ContentType="application/json"
    )

    return {"statusCode": 200, "body": f"{event_type} processed: {body}"}

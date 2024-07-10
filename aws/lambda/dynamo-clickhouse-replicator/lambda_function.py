import json
import os
import re
from collections import defaultdict
from enum import Enum
from typing import Any, Dict, Optional, Union
from warnings import warn

import clickhouse_connect


DYNAMODB_TABLE_REGEX = re.compile(
    "arn:aws:dynamodb:.*?:.*?:table/(?P<table>[0-9a-zA-Z_-]+)/.+"
)
CLICKHOUSE_ENDPOINT = os.getenv("CLICKHOUSE_ENDPOINT", "")
CLICKHOUSE_USERNAME = os.getenv("CLICKHOUSE_USERNAME", "default")
CLICKHOUSE_PASSWORD = os.getenv("CLICKHOUSE_PASSWORD", "")


class EventType(Enum):
    INSERT = "INSERT"
    REMOVE = "REMOVE"
    MODIFY = "MODIFY"


def lambda_handler(event: Any, context: Any) -> None:
    # https://clickhouse.com/docs/en/integrations/python
    clickhouse_client = clickhouse_connect.get_client(
        host=CLICKHOUSE_ENDPOINT,
        user=CLICKHOUSE_USERNAME,
        password=CLICKHOUSE_PASSWORD,
        secure=True,
    )

    counts = defaultdict(int)
    for record in event["Records"]:
        event_name = record.get("eventName", "")
        try:
            if (
                event_name == EventType.INSERT.value
                or event_name == EventType.MODIFY.value
            ):
                upsert_document(clickhouse_client, record)
            elif event_name == EventType.REMOVE.value:
                remove_document(clickhouse_client, record)
            else:
                warn(f"Unrecognized event type {event_name} in {json.dumps(record)}")

            counts[event_name] += 1
        except Exception as error:
            warn(f"Failed to process {json.dumps(record)}: {error}")

    print(f"Finish processing {json.dumps(counts)}")


def extract_dynamodb_table(record: Any) -> Optional[str]:
    """
    Extract the DynamoDB table name from the source ARN. This will be used later as
    the index name
    """
    table = record.get("tableName", "")
    # In the case of a Kinesis stream, the table name has already been provided
    if table:
        return table

    s = record.get("eventSourceARN", "")
    m = DYNAMODB_TABLE_REGEX.match(s)
    if not m:
        warn(f"Invalid value {s}, expecting a DynamoDB table")
        return

    return m.group("table").lower()


def extract_dynamodb_key(record: Any) -> Optional[str]:
    keys = unmarshal({"M": record.get("dynamodb", {}).get("Keys", {})})
    if not keys:
        return
    return "|".join(keys.values())


def to_number(s: str) -> Union[int, float]:
    try:
        return int(s)
    except ValueError:
        return float(s)


def unmarshal(doc: Dict[Any, Any]) -> Any:
    """
    Convert the DynamoDB stream record into a regular JSON document. This is done recursively.
    At the top level, it will be a dictionary of type M (Map). Here is the list of DynamoDB
    attributes to handle:

    https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_streams_AttributeValue.html
    """
    for k, v in list(doc.items()):
        if k == "NULL":
            return

        if k == "S" or k == "BOOL":
            return v

        if k == "N":
            return to_number(v)

        if k == "M":
            return {sk: unmarshal(sv) for sk, sv in v.items()}

        if k == "BS" or k == "L":
            return [unmarshal(item) for item in v]

        if k == "SS":
            return v.copy()

        if k == "NS":
            return [to_number(item) for item in v]


def upsert_document(client: Any, record: Any) -> None:
    """
    Insert a new doc or modify an existing document. Note that ClickHouse doesn't really
    update the document in place, but rather adding a new record for the update
    """
    table = extract_dynamodb_table(record)
    if not table:
        return

    body = unmarshal({"M": record.get("dynamodb", {}).get("NewImage", {})})
    if not body:
        return

    id = extract_dynamodb_key(record)
    if not id:
        return

    # TODO (huydhn) Inserting individual record is not efficient according
    # to ClickHouse doc, but we can try to improve this later. See more at
    # https://clickhouse.com/docs/en/optimize/bulk-inserts
    print(f"UPSERTING {id} INTO {table}")
    # Checkout https://clickhouse.com/videos/how-to-upsert-rows-into-clickhouse
    # to understand how to upsert works in ClickHouse and how to get the latest
    # records. A generic way is to use the FINAL keyword but their doc mentions
    # that it's slower https://clickhouse.com/docs/en/sql-reference/statements/select/from
    client.query(f"INSERT INTO `{table}` FORMAT JSONEachRow {json.dumps(body)}")


def remove_document(client: Any, record: Any) -> None:
    """
    Remove a document. This is here for completeness as we don't remove records like ever
    """
    table = extract_dynamodb_table(record)
    if not table:
        return

    id = extract_dynamodb_key(record)
    if not id:
        return

    print(f"DELETING {id} FROM {table}")

    parameters = {"id": id}
    client.query(
        f"DELETE FROM `{table}` WHERE dynamoKey = %(id)s", parameters=parameters
    )

#!/usr/bin/env bash
# =============================================================================
# Kickflip Crawler — AWS Deployment Script
# =============================================================================
# Run this from the crawler directory:
#   cd KickflipEvents/crawler
#   bash aws/deploy.sh
#

# ── Windows / Git Bash: disable POSIX→Windows path auto-conversion ────────────
# Without this, Git Bash converts /kickflip/crawler → C:/Program Files/Git/kickflip/crawler
# which breaks AWS CLI arguments that are not file paths (log group names, ARNs, etc.)
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"
# Prerequisites:
#   - AWS CLI configured (aws configure)
#   - Docker running
#   - jq installed (brew install jq / apt install jq)
# =============================================================================

set -euo pipefail

# ── Windows-safe temp directory ───────────────────────────────────────────────
# MSYS_NO_PATHCONV=1 stops Git Bash converting /tmp → Windows path for the AWS
# CLI (a Windows exe). Instead, create a local temp dir and reference it with
# a Windows-format absolute path (C:/...) so AWS CLI can find the files.
# pwd -W returns the CWD in Windows format with forward slashes: C:/Users/...
mkdir -p aws/tmp
DEPLOY_TMP_WIN="$(pwd -W)/aws/tmp"
# ─────────────────────────────────────────────────────────────────────────────

# ── Config — edit these before first run ─────────────────────────────────────
AWS_REGION="us-east-1"
AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_REPO="kickflip-crawler"
ECS_CLUSTER="kickflip"
ECS_TASK_FAMILY="kickflip-crawler"
CONTAINER_NAME="kickflip-crawler"
CW_LOG_GROUP="/kickflip/crawler"
CW_STREAM_PREFIX="crawler"
SECRET_NAME="kickflip/crawler/prod"

# Lambda names
LAMBDA_STATUS="kickflip-get-job-status"
LAMBDA_LOGS="kickflip-get-job-logs"
LAMBDA_TRIGGER="kickflip-crawl-trigger"

ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}"

echo ""
echo "=== Kickflip Crawler — AWS Deploy ==="
echo "Account : ${AWS_ACCOUNT_ID}"
echo "Region  : ${AWS_REGION}"
echo "ECR URI : ${ECR_URI}"
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — ECR repository
# ─────────────────────────────────────────────────────────────────────────────
echo ">>> Step 1: Ensure ECR repository exists"
aws ecr describe-repositories --repository-names "${ECR_REPO}" \
    --region "${AWS_REGION}" > /dev/null 2>&1 || \
aws ecr create-repository \
    --repository-name "${ECR_REPO}" \
    --region "${AWS_REGION}" \
    --image-scanning-configuration scanOnPush=true \
    --query "repository.repositoryUri" --output text
echo "    ECR repo ready: ${ECR_URI}"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — Build & push Docker image
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo ">>> Step 2: Build and push Docker image"
aws ecr get-login-password --region "${AWS_REGION}" | \
    docker login --username AWS --password-stdin "${ECR_URI}"

IMAGE_TAG="$(date +%Y%m%d-%H%M%S)"
docker build \
    --platform linux/amd64 \
    -t "${ECR_REPO}:${IMAGE_TAG}" \
    -t "${ECR_REPO}:latest" \
    .

docker tag "${ECR_REPO}:${IMAGE_TAG}" "${ECR_URI}:${IMAGE_TAG}"
docker tag "${ECR_REPO}:latest"       "${ECR_URI}:latest"
docker push "${ECR_URI}:${IMAGE_TAG}"
docker push "${ECR_URI}:latest"
echo "    Pushed: ${ECR_URI}:${IMAGE_TAG}"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — Secrets Manager
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo ">>> Step 3: Ensure Secrets Manager secret exists"
echo "    NOTE: If this is first run, create the secret manually in the AWS"
echo "    Console with your real values before running this step."
echo "    Secret name: ${SECRET_NAME}"
echo ""
echo "    Required keys:"
echo "      DATABASE_URL, LLM_API_KEY, CRON_SECRET,"
echo "      SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_JWKS_URL"
echo ""
aws secretsmanager describe-secret \
    --secret-id "${SECRET_NAME}" \
    --region "${AWS_REGION}" \
    --query "Name" --output text 2>/dev/null \
    && echo "    Secret exists: ${SECRET_NAME}" \
    || { echo "    ERROR: Secret '${SECRET_NAME}' not found. Create it first."; exit 1; }

SECRET_ARN="$(aws secretsmanager describe-secret \
    --secret-id "${SECRET_NAME}" \
    --region "${AWS_REGION}" \
    --query "ARN" --output text)"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 — IAM roles
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo ">>> Step 4: Ensure IAM roles exist"

# ECS Task Execution Role (pulls image from ECR, writes CloudWatch logs, reads secrets)
EXEC_ROLE_NAME="kickflip-ecs-execution-role"
EXEC_ROLE_ARN=$(aws iam get-role --role-name "${EXEC_ROLE_NAME}" \
    --query "Role.Arn" --output text 2>/dev/null || echo "")

if [ -z "${EXEC_ROLE_ARN}" ]; then
    echo "    Creating ECS execution role..."
    EXEC_ROLE_ARN=$(aws iam create-role \
        --role-name "${EXEC_ROLE_NAME}" \
        --assume-role-policy-document '{
            "Version":"2012-10-17",
            "Statement":[{
                "Effect":"Allow",
                "Principal":{"Service":"ecs-tasks.amazonaws.com"},
                "Action":"sts:AssumeRole"
            }]
        }' \
        --query "Role.Arn" --output text)
    aws iam attach-role-policy \
        --role-name "${EXEC_ROLE_NAME}" \
        --policy-arn "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
    # Allow reading secrets
    aws iam put-role-policy \
        --role-name "${EXEC_ROLE_NAME}" \
        --policy-name "SecretsManagerRead" \
        --policy-document "{
            \"Version\":\"2012-10-17\",
            \"Statement\":[{
                \"Effect\":\"Allow\",
                \"Action\":[\"secretsmanager:GetSecretValue\"],
                \"Resource\":\"${SECRET_ARN}\"
            }]
        }"
fi
echo "    Execution role: ${EXEC_ROLE_ARN}"

# ECS Task Role (what the container itself can do — write CloudWatch logs)
TASK_ROLE_NAME="kickflip-ecs-task-role"
TASK_ROLE_ARN=$(aws iam get-role --role-name "${TASK_ROLE_NAME}" \
    --query "Role.Arn" --output text 2>/dev/null || echo "")

if [ -z "${TASK_ROLE_ARN}" ]; then
    echo "    Creating ECS task role..."
    TASK_ROLE_ARN=$(aws iam create-role \
        --role-name "${TASK_ROLE_NAME}" \
        --assume-role-policy-document '{
            "Version":"2012-10-17",
            "Statement":[{
                "Effect":"Allow",
                "Principal":{"Service":"ecs-tasks.amazonaws.com"},
                "Action":"sts:AssumeRole"
            }]
        }' \
        --query "Role.Arn" --output text)
    aws iam put-role-policy \
        --role-name "${TASK_ROLE_NAME}" \
        --policy-name "CloudWatchLogs" \
        --policy-document "{
            \"Version\":\"2012-10-17\",
            \"Statement\":[{
                \"Effect\":\"Allow\",
                \"Action\":[
                    \"logs:CreateLogStream\",
                    \"logs:PutLogEvents\"
                ],
                \"Resource\":\"arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:${CW_LOG_GROUP}:*\"
            }]
        }"
fi
echo "    Task role: ${TASK_ROLE_ARN}"

# Lambda execution role (reads CloudWatch logs + Secrets Manager)
LAMBDA_ROLE_NAME="kickflip-lambda-role"
LAMBDA_ROLE_ARN=$(aws iam get-role --role-name "${LAMBDA_ROLE_NAME}" \
    --query "Role.Arn" --output text 2>/dev/null || echo "")

if [ -z "${LAMBDA_ROLE_ARN}" ]; then
    echo "    Creating Lambda execution role..."
    LAMBDA_ROLE_ARN=$(aws iam create-role \
        --role-name "${LAMBDA_ROLE_NAME}" \
        --assume-role-policy-document '{
            "Version":"2012-10-17",
            "Statement":[{
                "Effect":"Allow",
                "Principal":{"Service":"lambda.amazonaws.com"},
                "Action":"sts:AssumeRole"
            }]
        }' \
        --query "Role.Arn" --output text)
    aws iam attach-role-policy \
        --role-name "${LAMBDA_ROLE_NAME}" \
        --policy-arn "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
    aws iam put-role-policy \
        --role-name "${LAMBDA_ROLE_NAME}" \
        --policy-name "CloudWatchLogsRead" \
        --policy-document "{
            \"Version\":\"2012-10-17\",
            \"Statement\":[{
                \"Effect\":\"Allow\",
                \"Action\":[
                    \"logs:GetLogEvents\",
                    \"logs:DescribeLogStreams\"
                ],
                \"Resource\":\"arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:${CW_LOG_GROUP}:*\"
            }]
        }"
    # Allow Lambda to run ECS tasks (for the trigger Lambda)
    aws iam put-role-policy \
        --role-name "${LAMBDA_ROLE_NAME}" \
        --policy-name "ECSRunTask" \
        --policy-document "{
            \"Version\":\"2012-10-17\",
            \"Statement\":[
                {
                    \"Effect\":\"Allow\",
                    \"Action\":[\"ecs:RunTask\"],
                    \"Resource\":\"arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT_ID}:task-definition/${ECS_TASK_FAMILY}:*\"
                },
                {
                    \"Effect\":\"Allow\",
                    \"Action\":[\"iam:PassRole\"],
                    \"Resource\":[\"${EXEC_ROLE_ARN}\",\"${TASK_ROLE_ARN}\"]
                }
            ]
        }"
fi
echo "    Lambda role: ${LAMBDA_ROLE_ARN}"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 — CloudWatch Log Group
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo ">>> Step 5: Ensure CloudWatch log group exists"
aws logs create-log-group \
    --log-group-name "${CW_LOG_GROUP}" \
    --region "${AWS_REGION}" 2>/dev/null || true
aws logs put-retention-policy \
    --log-group-name "${CW_LOG_GROUP}" \
    --retention-in-days 7 \
    --region "${AWS_REGION}"
echo "    Log group: ${CW_LOG_GROUP} (7-day retention)"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6 — ECS Cluster
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo ">>> Step 6: Ensure ECS Fargate cluster exists"

# Create ECS service-linked role if it doesn't exist (required on first ECS use in an account)
aws iam create-service-linked-role \
    --aws-service-name ecs.amazonaws.com 2>/dev/null \
    && echo "    Created ECS service-linked role (AWSServiceRoleForECS)" \
    || echo "    ECS service-linked role already exists"

aws ecs describe-clusters \
    --clusters "${ECS_CLUSTER}" \
    --region "${AWS_REGION}" \
    --query "clusters[0].clusterName" --output text 2>/dev/null | grep -q "${ECS_CLUSTER}" || \
aws ecs create-cluster \
    --cluster-name "${ECS_CLUSTER}" \
    --region "${AWS_REGION}" \
    --capacity-providers FARGATE FARGATE_SPOT \
    --query "cluster.clusterName" --output text
echo "    Cluster: ${ECS_CLUSTER}"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 7 — ECS Task Definition
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo ">>> Step 7: Register ECS task definition"

# Read the subnet and security group IDs from environment or prompt
# These must exist in your AWS account VPC
SUBNET_ID="${SUBNET_ID:-}"
SG_ID="${SG_ID:-}"

if [ -z "${SUBNET_ID}" ]; then
    # Use default VPC's first public subnet
    SUBNET_ID="$(aws ec2 describe-subnets \
        --filters "Name=default-for-az,Values=true" \
        --query "Subnets[0].SubnetId" \
        --output text \
        --region "${AWS_REGION}")"
    echo "    Using default subnet: ${SUBNET_ID}"
fi

if [ -z "${SG_ID}" ]; then
    # Use default security group
    SG_ID="$(aws ec2 describe-security-groups \
        --filters "Name=group-name,Values=default" \
        --query "SecurityGroups[0].GroupId" \
        --output text \
        --region "${AWS_REGION}")"
    echo "    Using default security group: ${SG_ID}"
fi

# Write task definition JSON
cat > "aws/tmp/kickflip-task-def.json" <<EOF
{
  "family": "${ECS_TASK_FAMILY}",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "${EXEC_ROLE_ARN}",
  "taskRoleArn": "${TASK_ROLE_ARN}",
  "containerDefinitions": [
    {
      "name": "${CONTAINER_NAME}",
      "image": "${ECR_URI}:latest",
      "essential": true,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "${CW_LOG_GROUP}",
          "awslogs-region": "${AWS_REGION}",
          "awslogs-stream-prefix": "${CW_STREAM_PREFIX}"
        }
      },
      "secrets": [
        {"name": "DATABASE_URL",         "valueFrom": "${SECRET_ARN}:DATABASE_URL::"},
        {"name": "LLM_API_KEY",           "valueFrom": "${SECRET_ARN}:LLM_API_KEY::"},
        {"name": "CRON_SECRET",           "valueFrom": "${SECRET_ARN}:CRON_SECRET::"},
        {"name": "SUPABASE_URL",          "valueFrom": "${SECRET_ARN}:SUPABASE_URL::"},
        {"name": "SUPABASE_SERVICE_KEY",  "valueFrom": "${SECRET_ARN}:SUPABASE_SERVICE_KEY::"},
        {"name": "SUPABASE_JWKS_URL",     "valueFrom": "${SECRET_ARN}:SUPABASE_JWKS_URL::"}
      ],
      "environment": [
        {"name": "ENABLE_PLAYWRIGHT",    "value": "true"},
        {"name": "PLAYWRIGHT_BROWSERS_PATH", "value": "/ms-playwright"},
        {"name": "LOG_LEVEL",            "value": "INFO"},
        {"name": "LLM_PROVIDER",         "value": "gemini"}
      ]
    }
  ]
}
EOF

TASK_DEF_ARN="$(aws ecs register-task-definition \
    --cli-input-json "$(cat aws/tmp/kickflip-task-def.json)" \
    --region "${AWS_REGION}" \
    --query "taskDefinition.taskDefinitionArn" --output text)"
echo "    Task definition: ${TASK_DEF_ARN}"

# Store network config for use in trigger Lambda + EventBridge
echo "${SUBNET_ID}" > "aws/tmp/kickflip-subnet.txt"
echo "${SG_ID}"     > "aws/tmp/kickflip-sg.txt"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 8 — Lambda: package and deploy
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo ">>> Step 8: Deploy Lambda functions"

# Fetch secret values once with Python (jq may not be installed on Windows Git Bash)
echo "    Reading secrets from Secrets Manager..."
SECRET_JSON="$(aws secretsmanager get-secret-value \
    --secret-id "${SECRET_NAME}" \
    --query 'SecretString' --output text \
    --region "${AWS_REGION}")"
LAMBDA_DB_URL="$(echo "${SECRET_JSON}"   | python -c "import sys,json; print(json.load(sys.stdin)['DATABASE_URL'])")"
LAMBDA_CRON_SECRET="$(echo "${SECRET_JSON}" | python -c "import sys,json; print(json.load(sys.stdin)['CRON_SECRET'])")"
echo "    Secrets loaded."

LAMBDA_RUNTIME="python3.11"
LAMBDA_DIR="$(pwd)/aws/lambdas"

_deploy_lambda() {
    local name=$1
    local handler_dir=$2
    local handler_file=$3   # e.g. "handler.handler"
    local extra_env=${4:-"{}"}

    echo "    Packaging ${name}..."
    local tmp_dir tmp_dir_win
    tmp_dir="$(mktemp -d)"
    tmp_dir_win="$(cd "${tmp_dir}" && pwd -W)"   # Windows path for Python + pip

    cp "${LAMBDA_DIR}/${handler_dir}/handler.py" "${tmp_dir}/"
    # Install dependencies into the package
    pip install \
        --quiet \
        --target "${tmp_dir_win}" \
        psycopg2-binary \
        2>/dev/null

    # zip_abs: Windows path for Python to write the zip
    # zip_rel: relative path for AWS CLI fileb:// (works on Windows without path issues)
    local zip_abs zip_rel
    zip_abs="$(pwd -W)/aws/tmp/${name}.zip"
    zip_rel="aws/tmp/${name}.zip"
    # Use Python zipfile instead of zip (zip not installed in Git Bash on Windows)
    python -c "
import zipfile, os, sys
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, _, files in os.walk(src):
        for f in files:
            fp = os.path.join(root, f)
            zf.write(fp, os.path.relpath(fp, src))
" "${tmp_dir_win}" "${zip_abs}"
    rm -rf "${tmp_dir}"

    # Deploy (create or update)
    if aws lambda get-function --function-name "${name}" \
        --region "${AWS_REGION}" > /dev/null 2>&1; then
        aws lambda update-function-code \
            --function-name "${name}" \
            --zip-file "fileb://${zip_rel}" \
            --region "${AWS_REGION}" \
            --query "FunctionName" --output text
        # Update env vars
        aws lambda update-function-configuration \
            --function-name "${name}" \
            --environment "Variables={DATABASE_URL=${LAMBDA_DB_URL},CRON_SECRET=${LAMBDA_CRON_SECRET},CW_LOG_GROUP=${CW_LOG_GROUP},CW_STREAM_PREFIX=${CW_STREAM_PREFIX},CW_CONTAINER_NAME=${CONTAINER_NAME}}" \
            --region "${AWS_REGION}" \
            --query "FunctionName" --output text
    else
        aws lambda create-function \
            --function-name "${name}" \
            --runtime "${LAMBDA_RUNTIME}" \
            --role "${LAMBDA_ROLE_ARN}" \
            --handler "${handler_file}" \
            --zip-file "fileb://${zip_rel}" \
            --timeout 30 \
            --memory-size 256 \
            --environment "Variables={DATABASE_URL=${LAMBDA_DB_URL},CRON_SECRET=${LAMBDA_CRON_SECRET},CW_LOG_GROUP=${CW_LOG_GROUP},CW_STREAM_PREFIX=${CW_STREAM_PREFIX},CW_CONTAINER_NAME=${CONTAINER_NAME}}" \
            --region "${AWS_REGION}" \
            --query "FunctionName" --output text
    fi
    echo "    Deployed: ${name}"
}

_deploy_lambda "${LAMBDA_STATUS}" "get_job_status" "handler.handler"
_deploy_lambda "${LAMBDA_LOGS}"   "get_job_logs"   "handler.handler"

# ── Trigger Lambda (runs ECS task on demand) ──────────────────────────────────
echo "    Packaging trigger Lambda..."
cat > "aws/tmp/kickflip_trigger_handler.py" <<PYEOF
import boto3, os, json

ECS_CLUSTER      = os.environ["ECS_CLUSTER"]
TASK_DEFINITION  = os.environ["TASK_DEFINITION"]
SUBNET_ID        = os.environ["SUBNET_ID"]
SECURITY_GROUP   = os.environ["SECURITY_GROUP"]
REGION           = os.environ.get("AWS_REGION", "us-east-1")
CRON_SECRET      = os.environ.get("CRON_SECRET", "")

def handler(event, context):
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    token   = headers.get("authorization", "").removeprefix("Bearer ").strip()
    if CRON_SECRET and token != CRON_SECRET:
        return {"statusCode": 401, "body": json.dumps({"detail": "Unauthorized"})}

    ecs = boto3.client("ecs", region_name=REGION)
    resp = ecs.run_task(
        cluster=ECS_CLUSTER,
        taskDefinition=TASK_DEFINITION,
        launchType="FARGATE",
        networkConfiguration={
            "awsvpcConfiguration": {
                "subnets": [SUBNET_ID],
                "securityGroups": [SECURITY_GROUP],
                "assignPublicIp": "ENABLED"
            }
        },
    )
    failures = resp.get("failures", [])
    if failures:
        return {"statusCode": 500, "body": json.dumps({"detail": failures[0].get("reason")})}

    task_arn = resp["tasks"][0]["taskArn"]
    return {
        "statusCode": 202,
        "body": json.dumps({"task_arn": task_arn, "detail": "ECS task started"})
    }
PYEOF

tmp_trigger="$(mktemp -d)"
tmp_trigger_win="$(cd "${tmp_trigger}" && pwd -W)"
cp "aws/tmp/kickflip_trigger_handler.py" "${tmp_trigger}/handler.py"
TRIGGER_ZIP_ABS="$(pwd -W)/aws/tmp/${LAMBDA_TRIGGER}.zip"   # Windows path for Python
TRIGGER_ZIP_REL="aws/tmp/${LAMBDA_TRIGGER}.zip"
python -c "
import zipfile, os, sys
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, _, files in os.walk(src):
        for f in files:
            fp = os.path.join(root, f)
            zf.write(fp, os.path.relpath(fp, src))
" "${tmp_trigger_win}" "${TRIGGER_ZIP_ABS}"
rm -rf "${tmp_trigger}"

if aws lambda get-function --function-name "${LAMBDA_TRIGGER}" \
    --region "${AWS_REGION}" > /dev/null 2>&1; then
    aws lambda update-function-code \
        --function-name "${LAMBDA_TRIGGER}" \
        --zip-file "fileb://${TRIGGER_ZIP_REL}" \
        --region "${AWS_REGION}" \
        --query "FunctionName" --output text
else
    aws lambda create-function \
        --function-name "${LAMBDA_TRIGGER}" \
        --runtime "${LAMBDA_RUNTIME}" \
        --role "${LAMBDA_ROLE_ARN}" \
        --handler "handler.handler" \
        --zip-file "fileb://${TRIGGER_ZIP_REL}" \
        --timeout 30 \
        --memory-size 128 \
        --environment "Variables={ECS_CLUSTER=${ECS_CLUSTER},TASK_DEFINITION=${TASK_DEF_ARN},SUBNET_ID=${SUBNET_ID},SECURITY_GROUP=${SG_ID},CRON_SECRET=${LAMBDA_CRON_SECRET}}" \
        --region "${AWS_REGION}" \
        --query "FunctionName" --output text
fi
echo "    Deployed: ${LAMBDA_TRIGGER}"

# ─────────────────────────────────────────────────────────────────────────────
# STEP 9 — EventBridge Scheduler (daily cron)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo ">>> Step 9: Create EventBridge Scheduler (daily 3 AM UTC)"

# Role for EventBridge to invoke ECS RunTask directly
SCHED_ROLE_NAME="kickflip-scheduler-role"
SCHED_ROLE_ARN=$(aws iam get-role --role-name "${SCHED_ROLE_NAME}" \
    --query "Role.Arn" --output text 2>/dev/null || echo "")

if [ -z "${SCHED_ROLE_ARN}" ]; then
    SCHED_ROLE_ARN=$(aws iam create-role \
        --role-name "${SCHED_ROLE_NAME}" \
        --assume-role-policy-document '{
            "Version":"2012-10-17",
            "Statement":[{
                "Effect":"Allow",
                "Principal":{"Service":"scheduler.amazonaws.com"},
                "Action":"sts:AssumeRole"
            }]
        }' \
        --query "Role.Arn" --output text)
    aws iam put-role-policy \
        --role-name "${SCHED_ROLE_NAME}" \
        --policy-name "RunECSTask" \
        --policy-document "{
            \"Version\":\"2012-10-17\",
            \"Statement\":[
                {
                    \"Effect\":\"Allow\",
                    \"Action\":[\"ecs:RunTask\"],
                    \"Resource\":\"arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT_ID}:task-definition/${ECS_TASK_FAMILY}:*\"
                },
                {
                    \"Effect\":\"Allow\",
                    \"Action\":[\"iam:PassRole\"],
                    \"Resource\":[\"${EXEC_ROLE_ARN}\",\"${TASK_ROLE_ARN}\"]
                }
            ]
        }"
fi

aws scheduler create-schedule \
    --name "kickflip-daily-crawl" \
    --schedule-expression "cron(0 3 * * ? *)" \
    --schedule-expression-timezone "UTC" \
    --flexible-time-window '{"Mode":"OFF"}' \
    --target "{
        \"Arn\": \"arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT_ID}:cluster/${ECS_CLUSTER}\",
        \"RoleArn\": \"${SCHED_ROLE_ARN}\",
        \"EcsParameters\": {
            \"TaskDefinitionArn\": \"${TASK_DEF_ARN}\",
            \"LaunchType\": \"FARGATE\",
            \"NetworkConfiguration\": {
                \"awsvpcConfiguration\": {
                    \"Subnets\": [\"${SUBNET_ID}\"],
                    \"SecurityGroups\": [\"${SG_ID}\"],
                    \"AssignPublicIp\": \"ENABLED\"
                }
            }
        }
    }" \
    --region "${AWS_REGION}" 2>/dev/null \
    || aws scheduler update-schedule \
        --name "kickflip-daily-crawl" \
        --schedule-expression "cron(0 3 * * ? *)" \
        --schedule-expression-timezone "UTC" \
        --flexible-time-window '{"Mode":"OFF"}' \
        --target "{
            \"Arn\": \"arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT_ID}:cluster/${ECS_CLUSTER}\",
            \"RoleArn\": \"${SCHED_ROLE_ARN}\",
            \"EcsParameters\": {
                \"TaskDefinitionArn\": \"${TASK_DEF_ARN}\",
                \"LaunchType\": \"FARGATE\",
                \"NetworkConfiguration\": {
                    \"awsvpcConfiguration\": {
                        \"Subnets\": [\"${SUBNET_ID}\"],
                        \"SecurityGroups\": [\"${SG_ID}\"],
                        \"AssignPublicIp\": \"ENABLED\"
                    }
                }
            }
        }" \
        --region "${AWS_REGION}"
echo "    Scheduler: kickflip-daily-crawl (cron 0 3 * * ? *)"

# ─────────────────────────────────────────────────────────────────────────────
# DONE
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Deployment complete ==="
echo ""
echo "Test the deployment:"
echo "  1. Trigger a manual crawl:"
echo "     aws ecs run-task \\"
echo "       --cluster ${ECS_CLUSTER} \\"
echo "       --task-definition ${ECS_TASK_FAMILY} \\"
echo "       --launch-type FARGATE \\"
echo "       --network-configuration 'awsvpcConfiguration={subnets=[${SUBNET_ID}],securityGroups=[${SG_ID}],assignPublicIp=ENABLED}' \\"
echo "       --region ${AWS_REGION}"
echo ""
echo "  2. Watch logs live:"
echo "     aws logs tail ${CW_LOG_GROUP} --follow --region ${AWS_REGION}"
echo ""
echo "  3. Check job status (replace JOB_ID with value from container stdout):"
echo "     aws lambda invoke --function-name ${LAMBDA_STATUS} \\"
echo "       --payload '{\"pathParameters\":{\"job_id\":\"JOB_ID\"}}' \\"
echo "       --region ${AWS_REGION} /dev/stdout"
echo ""

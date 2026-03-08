#!/usr/bin/env bash
# =============================================================================
# Kickflip — Set up S3 log storage for crawler jobs
# =============================================================================
# Run from the crawler directory:
#   cd KickflipEvents/crawler
#   bash aws/setup-log-s3.sh
#
# What this does:
#   1. Creates S3 bucket  kickflip-crawler-logs-<account-id>
#   2. Adds s3:PutObject  to ECS task role  (container uploads logs)
#   3. Adds s3:GetObject  to Lambda role    (Lambda reads logs)
#   4. Updates Lambda env var  LOG_S3_BUCKET
#   5. Registers new ECS task definition revision with LOG_S3_BUCKET env var
#   6. Redeploys get_job_logs Lambda with updated code (now reads from S3)
# =============================================================================

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

set -euo pipefail

AWS_REGION="us-east-1"
AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

# Names must match deploy.sh
TASK_ROLE_NAME="kickflip-ecs-task-role"
LAMBDA_ROLE_NAME="kickflip-lambda-role"
LAMBDA_LOGS="kickflip-get-job-logs"
ECS_TASK_FAMILY="kickflip-crawler"
CONTAINER_NAME="kickflip-crawler"
SECRET_NAME="kickflip/crawler/prod"

LOG_BUCKET="kickflip-crawler-logs-${AWS_ACCOUNT_ID}"

echo ""
echo "=== Kickflip — S3 Log Storage Setup ==="
echo "Account : ${AWS_ACCOUNT_ID}"
echo "Region  : ${AWS_REGION}"
echo "Bucket  : ${LOG_BUCKET}"
echo ""

# ── Step 1: Create S3 bucket ──────────────────────────────────────────────────
echo ">>> Step 1: Create S3 bucket"

aws s3api head-bucket --bucket "${LOG_BUCKET}" --region "${AWS_REGION}" 2>/dev/null \
    && echo "    Bucket already exists: ${LOG_BUCKET}" \
    || aws s3api create-bucket \
        --bucket "${LOG_BUCKET}" \
        --region "${AWS_REGION}" \
        && echo "    Created bucket: ${LOG_BUCKET}"

# 30-day lifecycle — auto-delete old logs to keep costs low
aws s3api put-bucket-lifecycle-configuration \
    --bucket "${LOG_BUCKET}" \
    --lifecycle-configuration '{
        "Rules": [{
            "ID": "delete-old-logs",
            "Status": "Enabled",
            "Filter": {"Prefix": "logs/"},
            "Expiration": {"Days": 30}
        }]
    }' \
    --region "${AWS_REGION}"
echo "    Lifecycle policy set: logs/ deleted after 30 days"

# ── Step 2: Grant ECS task role s3:PutObject ──────────────────────────────────
echo ""
echo ">>> Step 2: Grant ECS task role s3:PutObject"

aws iam put-role-policy \
    --role-name "${TASK_ROLE_NAME}" \
    --policy-name "S3LogUpload" \
    --policy-document "{
        \"Version\": \"2012-10-17\",
        \"Statement\": [{
            \"Effect\": \"Allow\",
            \"Action\": [\"s3:PutObject\"],
            \"Resource\": \"arn:aws:s3:::${LOG_BUCKET}/logs/*\"
        }]
    }"
echo "    ECS task role can now PutObject to s3://${LOG_BUCKET}/logs/*"

# ── Step 3: Grant Lambda role s3:GetObject ────────────────────────────────────
echo ""
echo ">>> Step 3: Grant Lambda role s3:GetObject"

aws iam put-role-policy \
    --role-name "${LAMBDA_ROLE_NAME}" \
    --policy-name "S3LogRead" \
    --policy-document "{
        \"Version\": \"2012-10-17\",
        \"Statement\": [{
            \"Effect\": \"Allow\",
            \"Action\": [\"s3:GetObject\"],
            \"Resource\": \"arn:aws:s3:::${LOG_BUCKET}/logs/*\"
        }]
    }"
echo "    Lambda role can now GetObject from s3://${LOG_BUCKET}/logs/*"

# ── Step 4: Update get_job_logs Lambda env vars ───────────────────────────────
echo ""
echo ">>> Step 4: Update ${LAMBDA_LOGS} environment variables"

# Fetch existing secret values (needed to preserve other env vars)
SECRET_JSON="$(aws secretsmanager get-secret-value \
    --secret-id "${SECRET_NAME}" \
    --query 'SecretString' --output text \
    --region "${AWS_REGION}")"
LAMBDA_DB_URL="$(echo "${SECRET_JSON}" | python -c "import sys,json; print(json.load(sys.stdin)['DATABASE_URL'])")"
LAMBDA_CRON_SECRET="$(echo "${SECRET_JSON}" | python -c "import sys,json; print(json.load(sys.stdin)['CRON_SECRET'])")"

# Read existing CW config from task def file
CW_LOG_GROUP="$(python -c "
import json
with open('aws/tmp/kickflip-task-def.json') as f:
    td = json.load(f)
opts = td['containerDefinitions'][0]['logConfiguration']['options']
print(opts.get('awslogs-group', '/kickflip/crawler'))
" 2>/dev/null || echo "/kickflip/crawler")"
CW_STREAM_PREFIX="$(python -c "
import json
with open('aws/tmp/kickflip-task-def.json') as f:
    td = json.load(f)
opts = td['containerDefinitions'][0]['logConfiguration']['options']
print(opts.get('awslogs-stream-prefix', 'crawler'))
" 2>/dev/null || echo "crawler")"

aws lambda update-function-configuration \
    --function-name "${LAMBDA_LOGS}" \
    --environment "Variables={
        DATABASE_URL=${LAMBDA_DB_URL},
        CRON_SECRET=${LAMBDA_CRON_SECRET},
        LOG_S3_BUCKET=${LOG_BUCKET},
        CW_LOG_GROUP=${CW_LOG_GROUP},
        CW_STREAM_PREFIX=${CW_STREAM_PREFIX},
        CW_CONTAINER_NAME=${CONTAINER_NAME}
    }" \
    --region "${AWS_REGION}" \
    --query "FunctionName" --output text
echo "    ${LAMBDA_LOGS} env vars updated (LOG_S3_BUCKET=${LOG_BUCKET})"

# ── Step 5: New ECS task definition with LOG_S3_BUCKET ───────────────────────
echo ""
echo ">>> Step 5: Register new ECS task definition with LOG_S3_BUCKET"

# Read current task def, inject LOG_S3_BUCKET into environment
python -c "
import json, sys

with open('aws/tmp/kickflip-task-def.json') as f:
    td = json.load(f)

env = td['containerDefinitions'][0].get('environment', [])
# Remove any existing LOG_S3_BUCKET entry (idempotent)
env = [e for e in env if e['name'] != 'LOG_S3_BUCKET']
env.append({'name': 'LOG_S3_BUCKET', 'value': sys.argv[1]})
td['containerDefinitions'][0]['environment'] = env

with open('aws/tmp/kickflip-task-def.json', 'w') as f:
    json.dump(td, f, indent=2)

print('Task def updated with LOG_S3_BUCKET')
" "${LOG_BUCKET}"

NEW_TASK_DEF_ARN="$(aws ecs register-task-definition \
    --cli-input-json "$(cat aws/tmp/kickflip-task-def.json)" \
    --region "${AWS_REGION}" \
    --query "taskDefinition.taskDefinitionArn" --output text)"
echo "    New task definition: ${NEW_TASK_DEF_ARN}"

# ── Step 6: Redeploy get_job_logs Lambda with updated code ───────────────────
echo ""
echo ">>> Step 6: Redeploy ${LAMBDA_LOGS} Lambda (with S3 reading)"

TMP_DIR="$(mktemp -d)"
TMP_WIN="$(cd "${TMP_DIR}" && pwd -W)"

cp aws/lambdas/get_job_logs/handler.py "${TMP_DIR}/"
pip install --quiet --target "${TMP_WIN}" pg8000 2>/dev/null

python -c "
import zipfile, os, sys
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, _, files in os.walk(src):
        for f in files:
            fp = os.path.join(root, f)
            zf.write(fp, os.path.relpath(fp, src))
" "${TMP_WIN}" "$(pwd -W)/aws/tmp/${LAMBDA_LOGS}.zip"
rm -rf "${TMP_DIR}"

aws lambda update-function-code \
    --function-name "${LAMBDA_LOGS}" \
    --zip-file "fileb://aws/tmp/${LAMBDA_LOGS}.zip" \
    --region "${AWS_REGION}" \
    --query "FunctionName" --output text
echo "    ${LAMBDA_LOGS} redeployed"

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "=== S3 log storage setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Run DB migration in Supabase SQL Editor:"
echo "     aws/migrations/002_add_log_s3_key.sql"
echo ""
echo "  2. Rebuild and push Docker image (added boto3 + LOG_S3_BUCKET):"
echo "     ECR_URI=${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/kickflip-crawler"
echo "     aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin \${ECR_URI}"
echo "     docker build --platform linux/amd64 -t kickflip-crawler:latest ."
echo "     docker tag kickflip-crawler:latest \${ECR_URI}:latest"
echo "     docker push \${ECR_URI}:latest"
echo ""
echo "  3. Test a crawl — after completion check S3:"
echo "     aws s3 ls s3://${LOG_BUCKET}/logs/ --region ${AWS_REGION}"
echo ""
echo "  4. View a log file:"
echo "     aws s3 cp s3://${LOG_BUCKET}/logs/<job_id>.jsonl - --region ${AWS_REGION} | head -20"

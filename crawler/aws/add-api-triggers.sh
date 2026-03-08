#!/usr/bin/env bash
# =============================================================================
# Kickflip — Add API Gateway triggers to Lambda functions
# =============================================================================
# Run from the crawler directory:
#   cd KickflipEvents/crawler
#   bash aws/add-api-triggers.sh
#
# What this does:
#   Adds three routes to your existing API Gateway:
#     GET  /jobs/{job_id}       → kickflip-get-job-status
#     GET  /jobs/{job_id}/logs  → kickflip-get-job-logs
#     POST /crawl/trigger       → kickflip-crawl-trigger
#
# Works with HTTP API (v2) — the default for modern API Gateway setups.
# If you are using REST API (v1), see the comment at the bottom.
# =============================================================================

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
AWS_REGION="us-east-1"
AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

LAMBDA_STATUS="kickflip-get-job-status"
LAMBDA_LOGS="kickflip-get-job-logs"
LAMBDA_TRIGGER="kickflip-crawl-trigger"

# ── Detect or set API Gateway ID ──────────────────────────────────────────────
# Pass your API ID as the first argument, or set API_ID env var.
# If neither is set, the script lists your HTTP APIs and you pick one.
API_ID="${1:-${API_ID:-}}"

if [ -z "${API_ID}" ]; then
    echo ""
    echo "No API_ID provided. Listing your HTTP APIs (v2)..."
    echo ""
    aws apigatewayv2 get-apis \
        --region "${AWS_REGION}" \
        --query "Items[*].{Name:Name,ApiId:ApiId,Endpoint:ApiEndpoint}" \
        --output table
    echo ""
    echo "Re-run with your API ID:"
    echo "  bash aws/add-api-triggers.sh <your-api-id>"
    echo "  # or"
    echo "  API_ID=abc123def bash aws/add-api-triggers.sh"
    exit 0
fi

echo ""
echo "=== Kickflip — Add API Gateway Triggers ==="
echo "Account    : ${AWS_ACCOUNT_ID}"
echo "Region     : ${AWS_REGION}"
echo "API ID     : ${API_ID}"
echo ""

# Verify the API exists and get its endpoint
API_ENDPOINT="$(aws apigatewayv2 get-api \
    --api-id "${API_ID}" \
    --region "${AWS_REGION}" \
    --query "ApiEndpoint" --output text)"
echo "API endpoint: ${API_ENDPOINT}"
echo ""

# ── Helper: create integration + route + Lambda permission ────────────────────
_add_route() {
    local method="$1"         # GET | POST
    local route_path="$2"     # e.g. /jobs/{job_id}
    local lambda_name="$3"
    local stmt_suffix="$4"    # unique suffix for permission statement ID

    local lambda_arn
    lambda_arn="arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:${lambda_name}"

    local route_key="${method} ${route_path}"
    echo ">>> Adding route: ${route_key}  →  ${lambda_name}"

    # 1. Create Lambda proxy integration
    local integration_id
    integration_id="$(aws apigatewayv2 create-integration \
        --api-id "${API_ID}" \
        --integration-type AWS_PROXY \
        --integration-uri "arn:aws:apigateway:${AWS_REGION}:lambda:path/2015-03-31/functions/${lambda_arn}/invocations" \
        --payload-format-version "2.0" \
        --region "${AWS_REGION}" \
        --query "IntegrationId" --output text)"
    echo "    Integration ID: ${integration_id}"

    # 2. Create route pointing at the integration
    local route_id
    route_id="$(aws apigatewayv2 create-route \
        --api-id "${API_ID}" \
        --route-key "${route_key}" \
        --target "integrations/${integration_id}" \
        --region "${AWS_REGION}" \
        --query "RouteId" --output text)"
    echo "    Route ID: ${route_id}"

    # 3. Grant API Gateway permission to invoke the Lambda
    #    Use || true so re-runs don't fail when permission already exists
    aws lambda add-permission \
        --function-name "${lambda_name}" \
        --statement-id "apigw-${API_ID}-${stmt_suffix}" \
        --action "lambda:InvokeFunction" \
        --principal "apigateway.amazonaws.com" \
        --source-arn "arn:aws:execute-api:${AWS_REGION}:${AWS_ACCOUNT_ID}:${API_ID}/*/*" \
        --region "${AWS_REGION}" \
        --query "Statement" --output text 2>/dev/null \
        || echo "    (Permission already exists — skipped)"

    echo "    Done: ${API_ENDPOINT}${route_path}"
    echo ""
}

# ── Add the three routes ──────────────────────────────────────────────────────

_add_route "GET"  "/jobs/{job_id}"      "${LAMBDA_STATUS}"  "status"
_add_route "GET"  "/jobs/{job_id}/logs" "${LAMBDA_LOGS}"    "logs"
_add_route "POST" "/crawl/trigger"      "${LAMBDA_TRIGGER}" "trigger"

# ── Deploy / ensure $default stage is auto-deployed ──────────────────────────
echo ">>> Checking auto-deploy on \$default stage..."
AUTO_DEPLOY="$(aws apigatewayv2 get-stage \
    --api-id "${API_ID}" \
    --stage-name '$default' \
    --region "${AWS_REGION}" \
    --query "AutoDeploy" --output text 2>/dev/null || echo "false")"

if [ "${AUTO_DEPLOY}" != "True" ] && [ "${AUTO_DEPLOY}" != "true" ]; then
    echo "    Auto-deploy is off — creating a deployment manually..."
    aws apigatewayv2 create-deployment \
        --api-id "${API_ID}" \
        --region "${AWS_REGION}" \
        --query "DeploymentId" --output text
    echo "    Deployed."
else
    echo "    Auto-deploy is ON — new routes are live immediately."
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=== Routes added ==="
echo ""
echo "  GET  ${API_ENDPOINT}/jobs/{job_id}"
echo "       → ${LAMBDA_STATUS}"
echo ""
echo "  GET  ${API_ENDPOINT}/jobs/{job_id}/logs"
echo "       → ${LAMBDA_LOGS}"
echo ""
echo "  POST ${API_ENDPOINT}/crawl/trigger"
echo "       → ${LAMBDA_TRIGGER}"
echo ""
echo "Test:"
echo "  # Trigger a crawl (replace YOUR_CRON_SECRET)"
echo "  curl -X POST ${API_ENDPOINT}/crawl/trigger \\"
echo "    -H 'Authorization: Bearer YOUR_CRON_SECRET'"
echo ""
echo "  # Check job status (replace JOB_ID)"
echo "  curl ${API_ENDPOINT}/jobs/JOB_ID"
echo ""
echo "  # Stream job logs"
echo "  curl '${API_ENDPOINT}/jobs/JOB_ID/logs'"
echo ""

# =============================================================================
# REST API (v1) — If you are using API Gateway v1 instead of v2:
# =============================================================================
# The main differences for REST API:
#   1. Use `aws apigateway` instead of `aws apigatewayv2`
#   2. Resources + methods instead of routes
#   3. Must create deployment + stage explicitly
#   4. Integration uses AWS_PROXY with a different URI format
#
# Commands for REST API (v1):
#
# # Get root resource ID
# ROOT_ID=$(aws apigateway get-resources --rest-api-id $API_ID \
#     --query "items[?path=='/'].id" --output text)
#
# # Create /jobs resource
# JOBS_ID=$(aws apigateway create-resource --rest-api-id $API_ID \
#     --parent-id $ROOT_ID --path-part jobs --query id --output text)
#
# # Create /jobs/{job_id} resource
# JOB_ID_RES=$(aws apigateway create-resource --rest-api-id $API_ID \
#     --parent-id $JOBS_ID --path-part "{job_id}" --query id --output text)
#
# # Create GET method on /jobs/{job_id}
# aws apigateway put-method --rest-api-id $API_ID --resource-id $JOB_ID_RES \
#     --http-method GET --authorization-type NONE
#
# # Create Lambda proxy integration
# aws apigateway put-integration --rest-api-id $API_ID --resource-id $JOB_ID_RES \
#     --http-method GET --type AWS_PROXY --integration-http-method POST \
#     --uri "arn:aws:apigateway:$AWS_REGION:lambda:path/2015-03-31/functions/arn:aws:lambda:$AWS_REGION:$AWS_ACCOUNT_ID:function:kickflip-get-job-status/invocations"
#
# # Deploy
# aws apigateway create-deployment --rest-api-id $API_ID --stage-name prod
# =============================================================================

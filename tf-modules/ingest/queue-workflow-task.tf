resource "aws_lambda_function" "queue_workflow_task" {
  function_name    = "${var.prefix}-QueueWorkflow"
  filename         = "${path.module}/../../tasks/queue-workflow/dist/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../../tasks/queue-workflow/dist/lambda.zip")
  handler          = "index.handler"
  role             = var.lambda_processing_role_arn
  runtime          = "nodejs14.x"
  timeout          = lookup(var.lambda_timeouts, "queue_workflow_task_timeout", 300)
  memory_size      = 1024

  layers = [var.cumulus_message_adapter_lambda_layer_version_arn]

  environment {
    variables = {
      stackName                   = var.prefix
      CUMULUS_MESSAGE_ADAPTER_DIR = "/opt/"
    }
  }

  dynamic "vpc_config" {
    for_each = length(var.lambda_subnet_ids) == 0 ? [] : [1]
    content {
      subnet_ids = var.lambda_subnet_ids
      security_group_ids = [
        aws_security_group.no_ingress_all_egress[0].id
      ]
    }
  }

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "queue_workflow_task" {
  name              = "/aws/lambda/${aws_lambda_function.queue_workflow_task.function_name}"
  retention_in_days = var.cloudwatch_log_retention_in_days
  tags              = var.tags
}

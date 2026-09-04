import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { BudgetTooSmallError } from '../context/context-assembler.service';
import { PersistenceDisabledError } from '../db/run-store.service';
import { GitHubApiError } from '../github/github-client';
import { NotAGitRepositoryError, UnknownRefError } from '../ingest/git-repo.service';
import { LlmResponseError } from '../llm/llm.service';
import { LlmHttpError } from '../llm/providers/http-llm.provider';
import { HeadNotCheckedOutError } from '../review/impact.service';
import { RuleSyntaxError } from '../graph/architecture-rules';

/**
 * Maps the pipeline's own errors to honest status codes.
 *
 * Without this every one of them is a bare `500 Internal server error` with no message —
 * observed: pointing the API at a path that is not a repository produced exactly that, so
 * a caller could not tell "you gave me a bad path" from "this service is broken". The
 * distinction matters most to a GitHub Action, which has to decide whether to retry.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    const mapped = this.map(exception);
    if (mapped) {
      response.status(mapped.status).json({
        statusCode: mapped.status,
        error: mapped.error,
        message: mapped.message,
      });
      return;
    }

    // Genuinely unexpected: log it with the stack, tell the caller nothing about internals.
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: 'Internal server error',
    });
  }

  private map(exception: unknown): { status: number; error: string; message: string } | null {
    // The caller named something that does not exist or cannot be analysed: their problem
    // to fix, and retrying will not help.
    if (
      exception instanceof NotAGitRepositoryError ||
      exception instanceof UnknownRefError ||
      exception instanceof HeadNotCheckedOutError ||
      exception instanceof RuleSyntaxError
    ) {
      return {
        status: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        message: exception.message,
      };
    }

    // Our configuration is wrong, not the request. 500, but with the reason: the operator
    // reading the response is the one who can fix it.
    if (exception instanceof BudgetTooSmallError) {
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'Misconfigured',
        message: exception.message,
      };
    }

    // Asking for a stored run when nothing is being stored. 503 rather than 404: the run
    // may well exist, we simply have nowhere to look, and a 404 would tell the caller the
    // opposite of the truth.
    if (exception instanceof PersistenceDisabledError) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'Persistence Disabled',
        message: exception.message,
      };
    }

    if (exception instanceof GitHubApiError) {
      return {
        status: HttpStatus.BAD_GATEWAY,
        error: 'GitHub Error',
        message: exception.message,
      };
    }

    // The upstream model failed. 502 rather than 500, because the fault is not here and a
    // caller deciding whether to retry needs to know which side broke.
    if (exception instanceof LlmHttpError) {
      return {
        status: HttpStatus.BAD_GATEWAY,
        error: 'Upstream Model Error',
        message: exception.message,
      };
    }

    if (exception instanceof LlmResponseError) {
      return {
        status: HttpStatus.BAD_GATEWAY,
        error: 'Upstream Model Error',
        message: exception.message,
      };
    }

    return null;
  }
}

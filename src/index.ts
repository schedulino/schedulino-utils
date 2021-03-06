/**
 * @author    Martin Micunda {@link http://martinmicunda.com}
 * @copyright Copyright (c) 2016, Martin Micunda
 * @license   GPL-3.0
 */
import Boom from '@hapi/boom';
import * as Sentry from '@sentry/node';
import {
  APIGatewayEvent,
  APIGatewayProxyHandler,
  APIGatewayProxyResult,
  Callback,
  Context,
  CustomAuthorizerEvent,
} from 'aws-lambda';
import { Lambda } from 'aws-sdk';
import { LambdaLog } from 'lambda-log';

import { parseAwsLambdaName } from './parser';

Sentry.init({
  dsn: process.env.SENTRY_DSN || '',
  environment: process.env.SERVERLESS_STAGE,
});

export { Boom };

// helper to exclude property from type https://stackoverflow.com/questions/48215950/exclude-property-from-type
export type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>;

// Type aliases to hide the 'aws-lambda' package and have consistent, short naming.
export type ApiContext = Context;
export type ApiEvent = APIGatewayEvent;
export type ApiHandler = APIGatewayProxyHandler;
export type ApiResponse = APIGatewayProxyResult;
export type AuthorizerEvent = CustomAuthorizerEvent;
export type InvocationResponse = Lambda.InvocationResponse;
export interface ApiEventLambdaInvoke {
  body?: string;
  resource: string;
  httpMethod: string;
  pathParameters?: { [name: string]: string };
  queryStringParameters?: { [name: string]: string };
  requestContext: { authorizer: { principalId: string } };
}

export const logger = new LambdaLog({
  debug: process.env.LOGGER_LEVEL === 'DEBUG',
  dev: !!process.env.IS_OFFLINE,
});

export const HttpHeader = {
  'Access-Control-Allow-Origin': '*', // Required for CORS support to work
  'Access-Control-Allow-Credentials': true, // Required for cookies, authorization headers with HTTPS
};

export const HttpStatusCode = {
  Ok: 200,
  Created: 201,
  NoContent: 204,
  BadRequest: 400,
};

export const HttpMethod = {
  Delete: 'DELETE',
  Get: 'GET',
  Post: 'POST',
  Update: 'PUT',
  Patch: 'PATCH',
};

// we need to export lambda instance for unit test
export const lambda: Lambda = new Lambda();

export class UtilsSvc {
  static async responseBuilder(
    fn: Function,
    statusCode?: number
  ): Promise<APIGatewayProxyResult> {
    return {
      headers: HttpHeader,
      body: JSON.stringify(await fn()) || '',
      statusCode: statusCode || HttpStatusCode.Ok,
    };
  }

  static unrecognizedOperationHandler(event: APIGatewayEvent): Boom {
    throw Boom.badRequest(`Unrecognized action command ${event.resource}`);
  }

  static errorHandler(lambdaHandlerFn: ApiHandler): ApiHandler {
    return async (
      event: ApiEvent,
      context: ApiContext,
      cb: Callback
    ): Promise<APIGatewayProxyResult> => {
      try {
        Sentry.configureScope(scope => {
          // make sure we check the `requestContext` as it is optional field CustomAuthorizerEvent
          if (event.requestContext && event.requestContext.authorizer) {
            const {
              principalId: accountId,
              userId,
              userRole,
            } = event.requestContext.authorizer;

            if (userId) {
              scope.setUser({ accountId, id: userId, role: userRole });
            } else {
              scope.setUser({ accountId });
            }
          }
          scope.setTag('lambda', context.functionName);
          scope.setExtras({
            awsRequestId: context.awsRequestId,
            remainingTimeInMillis: context.getRemainingTimeInMillis(),
            logGroupName: context.logGroupName,
            logStreamName: context.logStreamName,
            invokedFunctionArn: context.invokedFunctionArn,
            memoryLimitInMB: context.memoryLimitInMB,
            clientContext: context.clientContext,
          });
        });

        return (await lambdaHandlerFn(
          event,
          context,
          cb
        )) as APIGatewayProxyResult;
      } catch (error) {
        let boomPayload: Boom.Payload;

        if (Boom.isBoom(error)) {
          boomPayload = error.output.payload;
        } else if (error instanceof Error) {
          // TODO: the AWS authorization currently not support custom response only Unauthorized string message can be returned
          if (error.message === 'Unauthorized') {
            throw error;
          }

          logger.error(error);
          boomPayload = Boom.badImplementation(error.message).output.payload;

          Sentry.captureException(error);
          await Sentry.flush(2000);
        } else {
          boomPayload = Boom.badImplementation().output.payload;
        }

        return {
          headers: HttpHeader,
          body: JSON.stringify(boomPayload),
          statusCode: boomPayload.statusCode,
        };
      }
    };
  }

  /**
   * The method calls the lambda function synchronously. This means that it will
   * wait until the called lambda function returns a result or fails.
   */
  static async lambdaInvoke<T>(
    name: string,
    payload: ApiEventLambdaInvoke
  ): Promise<T | Boom> {
    const parsed = parseAwsLambdaName(name);

    if (!parsed) {
      throw Boom.badImplementation('Please provide a valid function name')
        .output.payload;
    }

    const params: Lambda.Types.InvocationRequest = {
      FunctionName: parsed.functionName,
      InvocationType: 'RequestResponse',
      Payload: JSON.stringify(payload),
    };

    if (parsed.qualifier) {
      params.Qualifier = parsed.qualifier;
    }

    const data = (await lambda.invoke(params).promise()).Payload as string;
    /**
     * There are three different responses that we can expect from lambda invoke function
     * 1. success - the lambda was invoked without error and returns APIGatewayProxyResult
     *              in that case we just parse APIGatewayProxyResult.body
     * 2. error - the lambda was invoked with error however the error was properly handle
     *            by Boom in the invoked function so it returns APIGatewayProxyResult which
     *            contains string parsed Boom error {error: '', statusCode: ''} in the
     *            APIGatewayProxyResult.body
     * 3. error - the lambda was invoked with error and the error was NOT handle in the
     *            invoked function so it's exception error. The response won't contains any
     *            APIGatewayProxyResult and instead it return string parsed error object { errorMessage: string}
     */
    let parsedData:
      | APIGatewayProxyResult & { errorMessage: string }
      | null = null;
    let parsedBody:
      | T & {
          error: string;
          statusCode: number;
          message?: string;
          data?: unknown;
        } & { errorMessage: string }
      | null = null;

    try {
      parsedData = JSON.parse(data);
      parsedBody =
        parsedData && parsedData.body
          ? JSON.parse(parsedData.body)
          : parsedData;
    } catch (err) {}

    if (parsedBody && parsedBody.errorMessage) {
      logger.error(
        `APPLICATION EXCEPTION FROM INVOKED LAMBDA::${parsed.functionName} MESSAGE::${parsedBody.errorMessage}`
      );

      Sentry.captureException(parsedBody);
      await Sentry.flush(2000);

      throw Boom.badImplementation(parsedBody.errorMessage);
    }

    if (parsedBody && (parsedBody.error && parsedBody.statusCode)) {
      throw new Boom(parsedBody.error, {
        ...{ statusCode: parsedBody.statusCode },
        message: parsedBody.message,
        data: parsedBody.data,
      });
    }

    return parsedBody as T;
  }

  /**
   * The method calls the lambda function asynchronously. This means that it will if you don't
   * have to wait for the response of the lambda function you can use the invokeAsync method.
   */
  static async lambdaInvokeAsync(
    name: string,
    payload: ApiEventLambdaInvoke
  ): Promise<Lambda.InvocationResponse> {
    const parsed = parseAwsLambdaName(name);

    if (!parsed) {
      throw Boom.badImplementation('Please provide a valid function name')
        .output.payload;
    }

    const params: Lambda.Types.InvocationRequest = {
      FunctionName: parsed.functionName,
      InvocationType: 'Event',
      Payload: JSON.stringify(payload),
    };

    if (parsed.qualifier) {
      params.Qualifier = parsed.qualifier;
    }

    return await lambda.invoke(params).promise();
  }
}

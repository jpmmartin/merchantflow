import type { IncomingMessage } from 'node:http';
import {
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Public } from '../../auth/api/route-access.js';
import { ApiErrorResponses } from '../../errors/api/api-error-responses.decorator.js';
import { ApiException } from '../../errors/api/api-exception.js';
import { CorrelationId } from '../../logging/correlation-id.decorator.js';
import { toAuthorizationActionResult } from '../../payments/api/authorization-action.presenter.js';
import { toPaymentConfirmationResponse } from '../../payments/api/payment-confirmation.presenter.js';
import { toRefundCreationResponse } from '../../payments/api/refund.presenter.js';
import { ReceiveProviderEventService } from '../application/receive-provider-event.service.js';

/** Provider code of the deliveries this controller receives. */
const STRIPE = 'stripe';

/** Route of the receiver below the API prefix; the raw body is kept for it only. */
export const STRIPE_WEBHOOK_ROUTE = 'webhooks/stripe';

const webhookAcknowledgementSchema = z.object({
  received: z.literal(true),
});

type WebhookAcknowledgement = z.infer<typeof webhookAcknowledgementSchema>;

/**
 * Receives the Stripe webhook deliveries of one processor account. The route
 * is public: a delivery carries no API key, and only its signature, checked on
 * the raw body with the account's own signing secret, authenticates it. The
 * answers the payments module would store under an idempotency key are built
 * with its presenters, so a resolution stores the same answer the request
 * would have stored.
 */
@ApiTags('Webhooks')
@Controller(STRIPE_WEBHOOK_ROUTE)
export class StripeWebhookController {
  constructor(private readonly receive: ReceiveProviderEventService) {}

  @Post(':processorAccountId')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Receive a Stripe webhook delivery for one processor account',
    description:
      'Public, authenticated only by the Stripe-Signature header, which is verified on the raw body with the account’s signing secret and Stripe’s default tolerance of 300 seconds. An unknown account, a disabled one, one without a signing secret, a missing or bad signature, and a live-mode event all get the same 400 WEBHOOK_REJECTED. A verified event is stored in the inbox first, unique per account and event ID; an event already processed is acknowledged again with 200 and changes nothing. Otherwise the payment, refund, or capture or void it names is read from Stripe and applied with the platform’s conditional updates; other event types are recorded as ignored. If processing fails, the event stays stored as FAILED, the answer is 503 WEBHOOK_PROCESSING_FAILED, and Stripe’s redelivery processes it again. Answered within about six seconds.',
  })
  @ApiResponse({
    status: 200,
    description:
      'The event is stored and processed (or ignored), now or before.',
    standardSchema: webhookAcknowledgementSchema,
  })
  @ApiErrorResponses(
    {
      status: 400,
      description:
        'WEBHOOK_REJECTED: the delivery could not be verified. The answer is the same whatever the reason.',
    },
    {
      status: 503,
      description:
        'WEBHOOK_PROCESSING_FAILED: the event is stored and could not be processed yet. Deliver it again later.',
    },
  )
  async receiveDelivery(
    @CorrelationId() correlationId: string,
    // Not validated by a schema, so that a malformed id gets the same answer
    // as any other delivery that cannot be verified.
    @Param('processorAccountId') processorAccountId: string,
    @Headers('stripe-signature') signatureHeader: string | undefined,
    @Req() request: RawBodyRequest<IncomingMessage>,
  ): Promise<WebhookAcknowledgement> {
    const result = await this.receive.execute({
      correlationId,
      provider: STRIPE,
      processorAccountId,
      payload: request.rawBody,
      signatureHeader,
      presentConfirmation: toPaymentConfirmationResponse,
      presentRefund: toRefundCreationResponse,
      presentAuthorizationAction: toAuthorizationActionResult,
    });
    switch (result.outcome) {
      case 'REJECTED':
        throw new ApiException('WEBHOOK_REJECTED');
      case 'NOT_PROCESSED':
        throw new ApiException('WEBHOOK_PROCESSING_FAILED');
      case 'ACKNOWLEDGED':
        return { received: true };
    }
  }
}

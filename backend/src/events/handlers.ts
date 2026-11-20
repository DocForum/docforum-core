// Domain-event handlers. Registration happens once, before dispatch starts
// (src/jobs/outbox-events.ts). Every handler must be idempotent: the outbox
// delivers at least once, including after a crash between the side effect and
// the "processed" write (see ./README.md).
import * as notificationsService from '../modules/notifications/services';
import * as paymentsService from '../modules/payments/services';
import { registerHandler } from './index';

export function registerDomainEventHandlers(): () => void {
	const unregister = [
		registerHandler('appointment.booked', async (event) => {
			const payload = event.payload as { appointmentId: string; patientUserId: string };
			await notificationsService.notify(
				payload.patientUserId,
				'booking_confirmed',
				{ appointmentId: payload.appointmentId },
				{ sourceEventId: event.id },
			);
		}),

		// Issues #83/#84 — automatic escrow settlement. The producer published
		// these inside the transaction that actually transitioned the order, so
		// reaching this handler means the order really is fulfilled/rejected/
		// expired. The payments services are idempotent and handle the on-chain
		// NotFunded case as a terminal reconcile rather than throwing.
		registerHandler('order.fulfilled', async (event) => {
			const payload = event.payload as {
				orderType: 'prescription' | 'lab_order';
				orderId: string;
			};
			await paymentsService.releaseEscrowForFulfilledOrder(payload);
		}),

		registerHandler('order.rejected', async (event) => {
			const payload = event.payload as {
				orderType: 'prescription' | 'lab_order';
				orderId: string;
			};
			await paymentsService.refundEscrowForUnfulfilledOrder(payload);
		}),

		registerHandler('order.expired', async (event) => {
			const payload = event.payload as {
				orderType: 'prescription' | 'lab_order';
				orderId: string;
			};
			await paymentsService.refundEscrowForUnfulfilledOrder(payload);
		}),
	];

	return () => {
		for (const remove of unregister) remove();
	};
}

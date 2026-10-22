import * as notificationsService from '../modules/notifications/services';
import { registerHandler } from './index';

export function registerDomainEventHandlers(): () => void {
	return registerHandler('appointment.booked', async (event) => {
		const payload = event.payload as { appointmentId: string; patientUserId: string };
		await notificationsService.notify(
			payload.patientUserId,
			'booking_confirmed',
			{ appointmentId: payload.appointmentId },
			{ sourceEventId: event.id },
		);
	});
}
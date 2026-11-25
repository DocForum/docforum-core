import { config } from '../config';
import { pollEscrowContractEvents } from '../modules/payments/services/escrow-events';
import { runWithRlsBypassContext } from '../db/prisma-client';

export function startEscrowEventPoller(): () => void {
  let running = false;
  const poll = () => {
    if (running) return;
    running = true;
    void runWithRlsBypassContext(() => pollEscrowContractEvents())
      .catch((_error) => {
        // Errors are logged elsewhere; suppress here to avoid double-logging.
      })
      .finally(() => { running = false; });
  };
  if (config.payments.escrowContracts.length === 0) return () => {};
  const timer = setInterval(poll, config.payments.escrowEventPollIntervalSeconds * 1000);
  timer.unref();
  poll();
  return () => clearInterval(timer);
}

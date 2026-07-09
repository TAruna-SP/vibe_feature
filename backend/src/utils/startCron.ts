import {getFromContainer} from 'routing-controllers';
import {AutoEjectionEngine} from '#root/modules/ejectionPolicy/services/AutoEjectionEngine.js';
import {DeleteCronService} from '#root/modules/courses/services/deleteCronService.js';
import {initJobs} from '#root/bootstrap/jobs/index.js';

export const startCron = () => {
  try {
    // Get DeleteCronService from the existing container and schedule it
    const deleteCronService = getFromContainer(DeleteCronService);
    initJobs();
    deleteCronService.scheduleDeleteCron();

    console.log('✅ Delete cron job scheduled successfully');

    // scheduleProgressUpdateCron is async because it eagerly invokes the
    // bulk update. On a fresh/empty database it throws "Course not found",
    // which would become an unhandled rejection. Swallow it so the process
    // stays up.
    deleteCronService.scheduleProgressUpdateCron()
      .then(() => console.log('✅ Progress update cron job scheduled successfully'))
      .catch((err) => {
        console.warn('⚠️  Progress update cron initial run failed (likely empty DB; will retry on schedule):', err?.message || err);
      });

    // ── Auto-Ejection Engine ──────────────────────────────────────
    const autoEjectionEngine = getFromContainer(AutoEjectionEngine);

    autoEjectionEngine.scheduleAutoEjectionCron();

    console.log('✅ Auto-ejection engine scheduled successfully');
  } catch (error) {
    console.error('❌ Failed to initialize delete cron service:', error);
  }
};

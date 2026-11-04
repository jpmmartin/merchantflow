import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ClockModule } from '../clock/clock.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { NotificationsController } from './api/notifications.controller.js';
import { ListNotificationsService } from './application/list-notifications.service.js';
import { MarkNotificationsReadService } from './application/mark-notifications-read.service.js';
import { RecordNotificationService } from './application/record-notification.service.js';
import { StreamNotificationsService } from './application/stream-notifications.service.js';
import { NotificationHub } from './infrastructure/notification-hub.js';

/**
 * Notifications of payment and refund changes made without a request of the
 * user (P-11). It owns `notifications` and `notification_reads`. Other
 * modules write a notification only through the exported
 * `RecordNotificationService`, inside their own transaction; this module
 * imports none of them except auth (the session check of open streams), so
 * no cycle forms. Delivery runs through PostgreSQL `LISTEN/NOTIFY` on one
 * dedicated connection (`NotificationHub`) and a Server-Sent Events route.
 */
@Module({
  imports: [DatabaseModule, ClockModule, AuthModule],
  controllers: [NotificationsController],
  providers: [
    RecordNotificationService,
    ListNotificationsService,
    MarkNotificationsReadService,
    StreamNotificationsService,
    NotificationHub,
  ],
  exports: [RecordNotificationService],
})
export class NotificationsModule {}

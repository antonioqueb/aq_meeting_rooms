/** @odoo-module **/

import { registry } from '@web/core/registry';
import { useService } from '@web/core/utils/hooks';
import { Component, onWillStart, useState } from '@odoo/owl';

class AqMeetingRoomsDashboard extends Component {
    setup() {
        this.orm = useService('orm');
        this.action = useService('action');
        this.notification = useService('notification');
        this.state = useState({
            loading: true,
            rooms: [],
            bookings: [],
            pendingBookings: [],
            selectedRoomId: false,
            canApprove: false,
            filters: {
                date: this._today(),
            },
            form: {
                start: this._defaultStart(),
                stop: this._defaultStop(),
                objective: '',
                agenda: '',
            },
        });
        onWillStart(async () => {
            await this.loadDashboard();
        });
    }

    _today() {
        return new Date().toISOString().slice(0, 10);
    }

    _pad(value) {
        return String(value).padStart(2, '0');
    }

    _defaultStart() {
        const date = new Date();
        date.setMinutes(0, 0, 0);
        date.setHours(date.getHours() + 1);
        return `${date.getFullYear()}-${this._pad(date.getMonth() + 1)}-${this._pad(date.getDate())}T${this._pad(date.getHours())}:00`;
    }

    _defaultStop() {
        const date = new Date();
        date.setMinutes(0, 0, 0);
        date.setHours(date.getHours() + 2);
        return `${date.getFullYear()}-${this._pad(date.getMonth() + 1)}-${this._pad(date.getDate())}T${this._pad(date.getHours())}:00`;
    }

    _normalizeDatetime(value) {
        if (!value) {
            return false;
        }
        return `${value.replace('T', ' ')}:00`;
    }

    async loadDashboard() {
        this.state.loading = true;
        try {
            const date = this.state.filters.date || this._today();
            const dateFrom = `${date} 00:00:00`;
            const dateTo = `${date} 23:59:59`;
            const data = await this.orm.call('aq.meeting.room', 'get_dashboard_data', [dateFrom, dateTo]);
            this.state.rooms = data.rooms || [];
            this.state.bookings = data.bookings || [];
            this.state.pendingBookings = data.pending_bookings || [];
            this.state.canApprove = Boolean(data.can_approve);
            if (!this.state.selectedRoomId && this.state.rooms.length) {
                this.state.selectedRoomId = this.state.rooms[0].id;
            }
            if (this.state.selectedRoomId && !this.state.rooms.some((room) => room.id === this.state.selectedRoomId)) {
                this.state.selectedRoomId = this.state.rooms.length ? this.state.rooms[0].id : false;
            }
        } catch (error) {
            this.notification.add(error.message || 'No fue posible cargar el dashboard de salas.', { type: 'danger' });
        } finally {
            this.state.loading = false;
        }
    }

    get selectedRoom() {
        return this.state.rooms.find((room) => room.id === this.state.selectedRoomId) || false;
    }

    get selectedBookings() {
        if (!this.state.selectedRoomId) {
            return [];
        }
        return this.state.bookings.filter((booking) => booking.room_id === this.state.selectedRoomId);
    }

    get availableRoomsCount() {
        return this.state.rooms.filter((room) => room.availability_state === 'free').length;
    }

    get busyRoomsCount() {
        return this.state.rooms.filter((room) => room.availability_state === 'busy').length;
    }

    selectRoomFromDataset(ev) {
        this.state.selectedRoomId = Number(ev.currentTarget.dataset.roomId);
    }

    onFormInput(ev) {
        const field = ev.currentTarget.dataset.field;
        this.state.form[field] = ev.currentTarget.value;
    }

    async onDateChange(ev) {
        this.state.filters.date = ev.currentTarget.value;
        await this.loadDashboard();
    }

    formatDateTime(value) {
        if (!value) {
            return '—';
        }
        return value.replace(' ', ' · ').slice(0, 18);
    }

    statusClass(value) {
        if (value === 'free') {
            return 'is-free';
        }
        if (value === 'busy') {
            return 'is-busy';
        }
        if (value === 'soon') {
            return 'is-soon';
        }
        return '';
    }

    bookingStateClass(value) {
        if (value === 'approved') {
            return 'is-approved';
        }
        if (value === 'pending') {
            return 'is-pending';
        }
        return '';
    }

    async createQuickRequest() {
        if (!this.state.selectedRoomId) {
            this.notification.add('Selecciona una sala para crear la solicitud.', { type: 'warning' });
            return;
        }
        const values = {
            room_id: this.state.selectedRoomId,
            start: this._normalizeDatetime(this.state.form.start),
            stop: this._normalizeDatetime(this.state.form.stop),
            objective: this.state.form.objective,
            agenda: this.state.form.agenda,
        };
        try {
            await this.orm.call('aq.meeting.room.booking', 'dashboard_create_request', [values]);
            this.notification.add('Solicitud enviada para autorización.', { type: 'success' });
            this.state.form.objective = '';
            this.state.form.agenda = '';
            await this.loadDashboard();
        } catch (error) {
            this.notification.add(error.message || 'No fue posible crear la solicitud.', { type: 'danger' });
        }
    }

    openFullRequestForm() {
        const context = {
            default_room_id: this.state.selectedRoomId || false,
            default_start: this._normalizeDatetime(this.state.form.start),
            default_stop: this._normalizeDatetime(this.state.form.stop),
            default_objective: this.state.form.objective || false,
            default_agenda: this.state.form.agenda || false,
        };
        this.action.doAction({
            type: 'ir.actions.act_window',
            name: 'Nueva solicitud de sala',
            res_model: 'aq.meeting.room.booking',
            view_mode: 'form',
            views: [[false, 'form']],
            target: 'current',
            context,
        });
    }

    openBooking(ev) {
        const bookingId = Number(ev.currentTarget.dataset.bookingId);
        if (!bookingId) {
            return;
        }
        this.action.doAction({
            type: 'ir.actions.act_window',
            res_model: 'aq.meeting.room.booking',
            res_id: bookingId,
            view_mode: 'form',
            views: [[false, 'form']],
            target: 'current',
        });
    }

    async openMinute(ev) {
        const bookingId = Number(ev.currentTarget.dataset.bookingId);
        if (!bookingId) {
            return;
        }
        try {
            const action = await this.orm.call('aq.meeting.room.booking', 'action_open_minute', [[bookingId]]);
            this.action.doAction(action);
        } catch (error) {
            this.notification.add(error.message || 'No fue posible abrir la minuta.', { type: 'danger' });
        }
    }

    async approveBooking(ev) {
        const bookingId = Number(ev.currentTarget.dataset.bookingId);
        try {
            await this.orm.call('aq.meeting.room.booking', 'action_approve', [[bookingId]]);
            this.notification.add('Solicitud autorizada.', { type: 'success' });
            await this.loadDashboard();
        } catch (error) {
            this.notification.add(error.message || 'No fue posible autorizar la solicitud.', { type: 'danger' });
        }
    }

    async rejectBooking(ev) {
        const bookingId = Number(ev.currentTarget.dataset.bookingId);
        try {
            await this.orm.call('aq.meeting.room.booking', 'action_reject', [[bookingId]]);
            this.notification.add('Solicitud rechazada.', { type: 'warning' });
            await this.loadDashboard();
        } catch (error) {
            this.notification.add(error.message || 'No fue posible rechazar la solicitud.', { type: 'danger' });
        }
    }
}

AqMeetingRoomsDashboard.template = 'aq_meeting_rooms.Dashboard';

registry.category('actions').add('aq_meeting_rooms.dashboard', AqMeetingRoomsDashboard);

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
            date: this._today(),
            form: {
                start: this._defaultTime(1),
                stop: this._defaultTime(2),
                objective: '',
                agenda: '',
            },
        });
        onWillStart(() => this.loadDashboard());
    }

    // --- Helpers de fecha ---------------------------------------------------

    _pad(value) {
        return String(value).padStart(2, '0');
    }

    _today() {
        return new Date().toISOString().slice(0, 10);
    }

    _defaultTime(offsetHours) {
        const d = new Date();
        d.setMinutes(0, 0, 0);
        d.setHours(d.getHours() + offsetHours);
        return `${d.getFullYear()}-${this._pad(d.getMonth() + 1)}-${this._pad(d.getDate())}T${this._pad(d.getHours())}:00`;
    }

    _normalizeDatetime(value) {
        if (!value) {
            return false;
        }
        const normalized = value.replace('T', ' ');
        return normalized.length === 16 ? `${normalized}:00` : normalized;
    }

    _dateFromDatetime(value) {
        return value && value.length >= 10 ? value.slice(0, 10) : false;
    }

    _syncFormDate(dateValue) {
        if (!dateValue) {
            return;
        }
        const startTime = (this.state.form.start && this.state.form.start.slice(11, 16)) || '09:00';
        const stopTime = (this.state.form.stop && this.state.form.stop.slice(11, 16)) || '10:00';
        this.state.form.start = `${dateValue}T${startTime}`;
        this.state.form.stop = `${dateValue}T${stopTime}`;
    }

    formatTime(value) {
        return value && value.length >= 16 ? value.slice(11, 16) : '—';
    }

    _errorMessage(error, fallback) {
        return (error && error.data && error.data.message) || (error && error.message) || fallback;
    }

    _findBookingById(bookingId) {
        return (
            this.state.bookings.find((b) => b.id === bookingId) ||
            this.state.pendingBookings.find((b) => b.id === bookingId) ||
            false
        );
    }

    // --- Carga --------------------------------------------------------------

    async loadDashboard(options = {}) {
        this.state.loading = true;
        try {
            const date = this.state.date || this._today();
            const data = await this.orm.call('aq.meeting.room', 'get_dashboard_data', [
                `${date} 00:00:00`,
                `${date} 23:59:59`,
            ]);

            this.state.rooms = data.rooms || [];
            this.state.bookings = data.bookings || [];
            this.state.pendingBookings = data.pending_bookings || [];
            this.state.canApprove = Boolean(data.can_approve);

            const preferred = options.preferredRoomId || this.state.selectedRoomId;
            const ids = this.state.rooms.map((r) => r.id);
            if (preferred && ids.includes(Number(preferred))) {
                this.state.selectedRoomId = Number(preferred);
            } else if (!ids.includes(this.state.selectedRoomId)) {
                this.state.selectedRoomId = ids.length ? ids[0] : false;
            }
        } catch (error) {
            this.notification.add(this._errorMessage(error, 'No fue posible cargar el dashboard.'), { type: 'danger' });
        } finally {
            this.state.loading = false;
        }
    }

    async refreshDashboard() {
        await this.loadDashboard();
    }

    async onDateChange(ev) {
        this.state.date = ev.currentTarget.value || this._today();
        this._syncFormDate(this.state.date);
        await this.loadDashboard();
    }

    // --- Derivados ----------------------------------------------------------

    get selectedRoom() {
        return this.state.rooms.find((r) => r.id === this.state.selectedRoomId) || false;
    }

    get selectedBookings() {
        if (!this.state.selectedRoomId) {
            return [];
        }
        return this.state.bookings.filter((b) => b.room_id === this.state.selectedRoomId);
    }

    get freeRoomsCount() {
        return this.state.rooms.filter((r) => r.availability_state === 'free').length;
    }

    get busyRoomsCount() {
        return this.state.rooms.filter((r) => r.availability_state === 'busy').length;
    }

    get hasInvalidSlot() {
        const start = this._normalizeDatetime(this.state.form.start);
        const stop = this._normalizeDatetime(this.state.form.stop);
        return Boolean(start && stop && start >= stop);
    }

    get quickConflicts() {
        const start = this._normalizeDatetime(this.state.form.start);
        const stop = this._normalizeDatetime(this.state.form.stop);
        if (!this.state.selectedRoomId || !start || !stop || start >= stop) {
            return [];
        }
        return this.state.bookings.filter(
            (b) =>
                b.room_id === this.state.selectedRoomId &&
                ['pending', 'approved'].includes(b.state) &&
                b.start < stop &&
                b.stop > start
        );
    }

    statusClass(value) {
        return { free: 'is-free', busy: 'is-busy', soon: 'is-soon' }[value] || '';
    }

    bookingStateClass(value) {
        return (
            {
                approved: 'is-approved',
                pending: 'is-pending',
                done: 'is-done',
                cancelled: 'is-muted',
                rejected: 'is-muted',
            }[value] || ''
        );
    }

    // --- Interacciones ------------------------------------------------------

    selectRoom(ev) {
        this.state.selectedRoomId = Number(ev.currentTarget.dataset.roomId);
    }

    onRoomSelect(ev) {
        this.state.selectedRoomId = Number(ev.currentTarget.value) || false;
    }

    async createQuickRequest() {
        if (!this.state.selectedRoomId) {
            this.notification.add('Selecciona una sala.', { type: 'warning' });
            return;
        }
        if (this.hasInvalidSlot) {
            this.notification.add('La hora de fin debe ser mayor que la de inicio.', { type: 'warning' });
            return;
        }
        if (this.quickConflicts.length) {
            this.notification.add('El horario cruza con otra reserva.', { type: 'warning' });
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
            const newBooking = await this.orm.call('aq.meeting.room.booking', 'dashboard_create_request', [values]);
            this.notification.add('Solicitud enviada para autorización.', { type: 'success' });
            this.state.form.objective = '';
            this.state.form.agenda = '';
            if (newBooking && newBooking.start) {
                this.state.date = this._dateFromDatetime(newBooking.start) || this.state.date;
            }
            await this.loadDashboard({ preferredRoomId: this.state.selectedRoomId });
        } catch (error) {
            this.notification.add(this._errorMessage(error, 'No fue posible crear la solicitud.'), { type: 'danger' });
        }
    }

    openFullRequestForm() {
        this.action.doAction({
            type: 'ir.actions.act_window',
            name: 'Nueva solicitud de sala',
            res_model: 'aq.meeting.room.booking',
            view_mode: 'form',
            views: [[false, 'form']],
            target: 'current',
            context: {
                default_room_id: this.state.selectedRoomId || false,
                default_start: this._normalizeDatetime(this.state.form.start),
                default_stop: this._normalizeDatetime(this.state.form.stop),
                default_objective: this.state.form.objective || false,
                default_agenda: this.state.form.agenda || false,
            },
        });
    }

    openRoomCalendar() {
        if (!this.state.selectedRoomId) {
            return;
        }
        this.action.doAction({
            type: 'ir.actions.act_window',
            name: 'Agenda de sala',
            res_model: 'aq.meeting.room.booking',
            view_mode: 'calendar,list,form',
            views: [[false, 'calendar'], [false, 'list'], [false, 'form']],
            target: 'current',
            domain: [['room_id', '=', this.state.selectedRoomId]],
            context: { default_room_id: this.state.selectedRoomId, search_default_today: 1 },
        });
    }

    openBooking(ev) {
        ev.stopPropagation();
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
        ev.stopPropagation();
        const bookingId = Number(ev.currentTarget.dataset.bookingId);
        if (!bookingId) {
            return;
        }
        try {
            const action = await this.orm.call('aq.meeting.room.booking', 'action_open_minute', [[bookingId]]);
            this.action.doAction(action);
        } catch (error) {
            this.notification.add(this._errorMessage(error, 'No fue posible abrir la minuta.'), { type: 'danger' });
        }
    }

    async approveBooking(ev) {
        ev.stopPropagation();
        const bookingId = Number(ev.currentTarget.dataset.bookingId);
        const booking = this._findBookingById(bookingId);
        try {
            await this.orm.call('aq.meeting.room.booking', 'action_approve', [[bookingId]]);
            this.notification.add('Solicitud autorizada.', { type: 'success' });
            if (booking) {
                this.state.selectedRoomId = booking.room_id;
                this.state.date = this._dateFromDatetime(booking.start) || this.state.date;
            }
            await this.loadDashboard({ preferredRoomId: this.state.selectedRoomId });
        } catch (error) {
            this.notification.add(this._errorMessage(error, 'No fue posible autorizar.'), { type: 'danger' });
        }
    }

    async rejectBooking(ev) {
        ev.stopPropagation();
        const bookingId = Number(ev.currentTarget.dataset.bookingId);
        try {
            await this.orm.call('aq.meeting.room.booking', 'action_reject', [[bookingId]]);
            this.notification.add('Solicitud rechazada.', { type: 'warning' });
            await this.loadDashboard();
        } catch (error) {
            this.notification.add(this._errorMessage(error, 'No fue posible rechazar.'), { type: 'danger' });
        }
    }
}

AqMeetingRoomsDashboard.template = 'aq_meeting_rooms.Dashboard';

registry.category('actions').add('aq_meeting_rooms.dashboard', AqMeetingRoomsDashboard);

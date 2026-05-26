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
            myOpenBookings: [],
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
        const normalized = value.replace('T', ' ');
        if (normalized.length === 16) {
            return `${normalized}:00`;
        }
        return normalized;
    }

    _dateFromDatetime(value) {
        if (!value || value.length < 10) {
            return false;
        }
        return value.slice(0, 10);
    }

    _timeFromDatetime(value) {
        if (!value || value.length < 16) {
            return '—';
        }
        return value.slice(11, 16);
    }

    _setFormDate(dateValue) {
        if (!dateValue) {
            return;
        }
        const startTime = (this.state.form.start && this.state.form.start.slice(11, 16)) || '09:00';
        const stopTime = (this.state.form.stop && this.state.form.stop.slice(11, 16)) || '10:00';
        this.state.form.start = `${dateValue}T${startTime}`;
        this.state.form.stop = `${dateValue}T${stopTime}`;
    }

    _errorMessage(error, fallback) {
        if (error && error.data && error.data.message) {
            return error.data.message;
        }
        if (error && error.message) {
            return error.message;
        }
        return fallback;
    }

    _findBookingById(bookingId) {
        return (
            this.state.bookings.find((booking) => booking.id === bookingId) ||
            this.state.pendingBookings.find((booking) => booking.id === bookingId) ||
            this.state.myOpenBookings.find((booking) => booking.id === bookingId) ||
            false
        );
    }

    _scrollToRequestCard() {
        window.setTimeout(() => {
            const requestCard = document.querySelector('.o_aq_meeting_dashboard .aq-request-card');
            if (requestCard) {
                requestCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }, 0);
    }

    async loadDashboard(options = {}) {
        this.state.loading = true;
        try {
            const date = this.state.filters.date || this._today();
            const dateFrom = `${date} 00:00:00`;
            const dateTo = `${date} 23:59:59`;
            const preferredRoomId = options.preferredRoomId || this.state.selectedRoomId || false;
            const data = await this.orm.call('aq.meeting.room', 'get_dashboard_data', [dateFrom, dateTo]);

            this.state.rooms = data.rooms || [];
            this.state.bookings = data.bookings || [];
            this.state.pendingBookings = data.pending_bookings || [];
            this.state.myOpenBookings = data.my_open_bookings || [];
            this.state.canApprove = Boolean(data.can_approve);

            if (preferredRoomId && this.state.rooms.some((room) => room.id === Number(preferredRoomId))) {
                this.state.selectedRoomId = Number(preferredRoomId);
            } else if (!this.state.selectedRoomId && this.state.rooms.length) {
                this.state.selectedRoomId = this.state.rooms[0].id;
            } else if (this.state.selectedRoomId && !this.state.rooms.some((room) => room.id === this.state.selectedRoomId)) {
                this.state.selectedRoomId = this.state.rooms.length ? this.state.rooms[0].id : false;
            }
        } catch (error) {
            this.notification.add(this._errorMessage(error, 'No fue posible cargar el dashboard de salas.'), { type: 'danger' });
        } finally {
            this.state.loading = false;
        }
    }

    async refreshDashboard() {
        await this.loadDashboard();
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

    get allDayBookings() {
        return this.state.bookings || [];
    }

    get availableRoomsCount() {
        return this.state.rooms.filter((room) => room.availability_state === 'free').length;
    }

    get busyRoomsCount() {
        return this.state.rooms.filter((room) => room.availability_state === 'busy').length;
    }

    get approvedBookingsCount() {
        return this.state.bookings.filter((booking) => booking.state === 'approved').length;
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
        return this.state.bookings.filter((booking) => {
            return (
                booking.room_id === this.state.selectedRoomId &&
                ['pending', 'approved'].includes(booking.state) &&
                booking.start < stop &&
                booking.stop > start
            );
        });
    }

    selectRoomFromDataset(ev) {
        this.state.selectedRoomId = Number(ev.currentTarget.dataset.roomId);
    }

    reserveRoomFromDataset(ev) {
        ev.preventDefault();
        ev.stopPropagation();
        this.state.selectedRoomId = Number(ev.currentTarget.dataset.roomId);
        this._setFormDate(this.state.filters.date);
        this._scrollToRequestCard();
    }

    reserveSelectedRoom() {
        this._setFormDate(this.state.filters.date);
        this._scrollToRequestCard();
    }

    onRoomSelect(ev) {
        this.state.selectedRoomId = Number(ev.currentTarget.value) || false;
    }

    async onDateChange(ev) {
        this.state.filters.date = ev.currentTarget.value || this._today();
        this._setFormDate(this.state.filters.date);
        await this.loadDashboard();
    }

    formatDateTime(value) {
        if (!value) {
            return '—';
        }
        return value.replace(' ', ' · ').slice(0, 18);
    }

    formatTime(value) {
        return this._timeFromDatetime(value);
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
        if (value === 'done') {
            return 'is-done';
        }
        if (value === 'cancelled' || value === 'rejected') {
            return 'is-muted';
        }
        return '';
    }

    async createQuickRequest() {
        if (!this.state.selectedRoomId) {
            this.notification.add('Selecciona una sala para crear la solicitud.', { type: 'warning' });
            return;
        }
        if (this.hasInvalidSlot) {
            this.notification.add('La hora de fin debe ser mayor que la hora de inicio.', { type: 'warning' });
            return;
        }
        if (this.quickConflicts.length) {
            this.notification.add('El horario seleccionado cruza con una solicitud o reserva existente.', { type: 'warning' });
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
            if (newBooking && newBooking.room_id) {
                this.state.selectedRoomId = newBooking.room_id;
            }
            if (newBooking && newBooking.start) {
                this.state.filters.date = this._dateFromDatetime(newBooking.start) || this.state.filters.date;
            }
            await this.loadDashboard({ preferredRoomId: this.state.selectedRoomId });
        } catch (error) {
            this.notification.add(this._errorMessage(error, 'No fue posible crear la solicitud.'), { type: 'danger' });
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

    openSelectedRoomBookings() {
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
            context: {
                default_room_id: this.state.selectedRoomId,
                search_default_today: 1,
            },
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
                this.state.filters.date = this._dateFromDatetime(booking.start) || this.state.filters.date;
            }
            await this.loadDashboard({ preferredRoomId: this.state.selectedRoomId });
        } catch (error) {
            this.notification.add(this._errorMessage(error, 'No fue posible autorizar la solicitud.'), { type: 'danger' });
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
            this.notification.add(this._errorMessage(error, 'No fue posible rechazar la solicitud.'), { type: 'danger' });
        }
    }
}

AqMeetingRoomsDashboard.template = 'aq_meeting_rooms.Dashboard';

registry.category('actions').add('aq_meeting_rooms.dashboard', AqMeetingRoomsDashboard);

/** @odoo-module **/

import { registry } from '@web/core/registry';
import { useService } from '@web/core/utils/hooks';
import { Component, onWillStart, useState } from '@odoo/owl';

const FIRST_HOUR = 8;
const LAST_HOUR = 20;
const TIMELINE_ROW_HEIGHT = 46;

class AqMeetingRoomsDashboard extends Component {
    setup() {
        this.orm = useService('orm');
        this.action = useService('action');
        this.notification = useService('notification');

        const today = this._today();

        this.state = useState({
            loading: true,
            rooms: [],
            bookings: [],
            pendingBookings: [],
            myOpenBookings: [],
            selectedRoomId: false,
            canApprove: false,
            date: today,
            lastUpdatedText: 'sin actualizar',
            form: {
                start: this._defaultTime(today, 1),
                stop: this._defaultTime(today, 2),
                objective: '',
                agenda: '',
            },
        });

        onWillStart(() => this.loadDashboard());
    }

    // ---------------------------------------------------------------------
    // Fechas y formato
    // ---------------------------------------------------------------------

    _pad(value) {
        return String(value).padStart(2, '0');
    }

    _today() {
        const d = new Date();
        return `${d.getFullYear()}-${this._pad(d.getMonth() + 1)}-${this._pad(d.getDate())}`;
    }

    _dateObject(dateValue) {
        if (!dateValue) {
            return new Date();
        }
        return new Date(`${dateValue}T00:00:00`);
    }

    _defaultTime(dateValue, offsetHours) {
        const d = new Date();
        d.setMinutes(0, 0, 0);
        d.setHours(d.getHours() + offsetHours);

        const hour = this._pad(d.getHours());
        return `${dateValue}T${hour}:00`;
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

    _timeFromDatetime(value) {
        return value && value.length >= 16 ? value.slice(11, 16) : false;
    }

    _minutesOfDay(value) {
        const time = this._timeFromDatetime(value);
        if (!time) {
            return 0;
        }
        const [hour, minute] = time.split(':').map(Number);
        return hour * 60 + minute;
    }

    _bookingStartMinute(booking) {
        const bookingDate = this._dateFromDatetime(booking.start);
        if (bookingDate && bookingDate < this.state.date) {
            return FIRST_HOUR * 60;
        }
        return this._minutesOfDay(booking.start);
    }

    _bookingStopMinute(booking) {
        const bookingDate = this._dateFromDatetime(booking.stop);
        if (bookingDate && bookingDate > this.state.date) {
            return (LAST_HOUR + 1) * 60;
        }
        const stopMinute = this._minutesOfDay(booking.stop);
        if (stopMinute === 0 && this._dateFromDatetime(booking.start) !== bookingDate) {
            return (LAST_HOUR + 1) * 60;
        }
        return stopMinute;
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

    _formatClock(hour, minute = 0) {
        const period = hour >= 12 ? 'pm' : 'am';
        const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
        return `${displayHour}:${this._pad(minute)}${period}`;
    }

    formatHour(hour) {
        return this._formatClock(Number(hour), 0);
    }

    formatTime(value) {
        if (typeof value === 'number') {
            return this.formatHour(value);
        }
        const time = this._timeFromDatetime(value);
        if (!time) {
            return '—';
        }
        const [hour, minute] = time.split(':').map(Number);
        return this._formatClock(hour, minute);
    }

    get dateLong() {
        const date = this._dateObject(this.state.date);
        const days = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
        const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
        return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`;
    }

    get dateShort() {
        const date = this._dateObject(this.state.date);
        return `${this._pad(date.getDate())}/${this._pad(date.getMonth() + 1)}/${date.getFullYear()}`;
    }

    get timelineHours() {
        const hours = [];
        for (let hour = FIRST_HOUR; hour <= LAST_HOUR; hour += 1) {
            hours.push(hour);
        }
        return hours;
    }

    get roomStripSlots() {
        const slots = [];
        for (let hour = FIRST_HOUR; hour < LAST_HOUR; hour += 1) {
            slots.push(hour);
        }
        return slots;
    }

    _errorMessage(error, fallback) {
        return (error && error.data && error.data.message) || (error && error.message) || fallback;
    }

    _findBookingById(bookingId) {
        return (
            this.state.bookings.find((booking) => booking.id === bookingId) ||
            this.state.pendingBookings.find((booking) => booking.id === bookingId) ||
            false
        );
    }

    _initials(name) {
        const source = (name || '').trim();
        if (!source) {
            return 'U';
        }
        return source
            .split(/\s+/)
            .map((part) => part[0])
            .join('')
            .slice(0, 2)
            .toUpperCase();
    }

    // ---------------------------------------------------------------------
    // Carga
    // ---------------------------------------------------------------------

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
            this.state.myOpenBookings = data.my_open_bookings || [];
            this.state.canApprove = Boolean(data.can_approve);
            this.state.lastUpdatedText = 'hace unos segundos';

            const preferred = options.preferredRoomId || this.state.selectedRoomId;
            const roomIds = this.state.rooms.map((room) => room.id);

            if (preferred && roomIds.includes(Number(preferred))) {
                this.state.selectedRoomId = Number(preferred);
            } else if (!roomIds.includes(this.state.selectedRoomId)) {
                this.state.selectedRoomId = roomIds.length ? roomIds[0] : false;
            }
        } catch (error) {
            this.notification.add(this._errorMessage(error, 'No fue posible cargar el dashboard.'), { type: 'danger' });
        } finally {
            this.state.loading = false;
        }
    }

    async refreshDashboard() {
        await this.loadDashboard({ preferredRoomId: this.state.selectedRoomId });
    }

    async onDateChange(ev) {
        this.state.date = ev.currentTarget.value || this._today();
        this._syncFormDate(this.state.date);
        await this.loadDashboard({ preferredRoomId: this.state.selectedRoomId });
    }

    async changeDateBy(ev) {
        const days = Number(ev.currentTarget.dataset.day || 0);
        const date = this._dateObject(this.state.date);
        date.setDate(date.getDate() + days);

        this.state.date = `${date.getFullYear()}-${this._pad(date.getMonth() + 1)}-${this._pad(date.getDate())}`;
        this._syncFormDate(this.state.date);

        await this.loadDashboard({ preferredRoomId: this.state.selectedRoomId });
    }

    // ---------------------------------------------------------------------
    // Derivados
    // ---------------------------------------------------------------------

    get selectedRoom() {
        return this.state.rooms.find((room) => room.id === this.state.selectedRoomId) || false;
    }

    get selectedBookings() {
        if (!this.state.selectedRoomId) {
            return [];
        }
        return this.state.bookings
            .filter((booking) => booking.room_id === this.state.selectedRoomId)
            .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    }

    get selectedRoomMetaParts() {
        const room = this.selectedRoom;
        if (!room) {
            return [];
        }

        const parts = [];
        parts.push(`${room.capacity || 0} personas`);

        if (room.location) {
            parts.push(room.location);
        }

        if (room.equipment) {
            const equipmentParts = room.equipment
                .split(/[\n,;]+/)
                .map((item) => item.trim())
                .filter(Boolean)
                .slice(0, 4);
            parts.push(...equipmentParts);
        }

        return parts;
    }

    get freeRoomsCount() {
        return this.state.rooms.filter((room) => this.roomDayStatus(room) === 'available').length;
    }

    get occupiedRoomsCount() {
        return this.state.rooms.filter((room) => this.roomDayStatus(room) === 'occupied').length;
    }

    get pendingRoomsCount() {
        return this.state.rooms.filter((room) => this.roomDayStatus(room) === 'pending').length;
    }

    get hasInvalidSlot() {
        const start = this._normalizeDatetime(this.state.form.start);
        const stop = this._normalizeDatetime(this.state.form.stop);
        return Boolean(start && stop && start >= stop);
    }

    get hasObjective() {
        return Boolean((this.state.form.objective || '').trim());
    }

    get quickConflicts() {
        const start = this._normalizeDatetime(this.state.form.start);
        const stop = this._normalizeDatetime(this.state.form.stop);

        if (!this.state.selectedRoomId || !start || !stop || start >= stop) {
            return [];
        }

        return this.state.bookings.filter(
            (booking) =>
                booking.room_id === this.state.selectedRoomId &&
                ['pending', 'approved'].includes(booking.state) &&
                booking.start < stop &&
                booking.stop > start
        );
    }

    roomBookings(roomId) {
        return this.state.bookings.filter((booking) => booking.room_id === roomId);
    }

    roomDayStatus(room) {
        const bookings = this.roomBookings(room.id);

        if (bookings.some((booking) => ['approved', 'done'].includes(booking.state))) {
            return 'occupied';
        }
        if (bookings.some((booking) => booking.state === 'pending')) {
            return 'pending';
        }
        return 'available';
    }

    roomStatusLabel(room) {
        const status = this.roomDayStatus(room);
        return {
            available: 'Libre',
            occupied: 'Ocupada',
            pending: 'Pendiente',
        }[status] || 'Libre';
    }

    roomDotClass(room) {
        return `is-${this.roomDayStatus(room)}`;
    }

    roomPillClass(room) {
        if (room.id === this.state.selectedRoomId) {
            return 'pill--ink';
        }
        return `pill--${this.roomDayStatus(room)}`;
    }

    roomHasBookingAt(roomId, hour) {
        const start = hour * 60;
        const stop = (hour + 1) * 60;

        return this.roomBookings(roomId).some((booking) => {
            const bookingStart = this._bookingStartMinute(booking);
            const bookingStop = this._bookingStopMinute(booking);
            return bookingStart < stop && bookingStop > start;
        });
    }

    bookingsAtHour(hour) {
        return this.selectedBookings.filter((booking) => {
            const startMinute = Math.max(FIRST_HOUR * 60, this._bookingStartMinute(booking));
            const displayHour = Math.floor(startMinute / 60);
            return displayHour === hour;
        });
    }

    timelineEventStyle(booking) {
        const lowerBound = FIRST_HOUR * 60;
        const upperBound = (LAST_HOUR + 1) * 60;

        const startMinute = Math.max(lowerBound, this._bookingStartMinute(booking));
        const stopMinute = Math.min(upperBound, this._bookingStopMinute(booking));
        const safeDuration = Math.max(30, stopMinute - startMinute);

        const top = ((startMinute % 60) / 60) * TIMELINE_ROW_HEIGHT;
        const height = Math.max(34, (safeDuration / 60) * TIMELINE_ROW_HEIGHT - 4);

        return `top: ${top}px; height: ${height}px;`;
    }

    bookingRange(booking) {
        return `${this.formatTime(booking.start)}–${this.formatTime(booking.stop)}`;
    }

    bookingStateClass(value) {
        return (
            {
                approved: 'is-approved',
                pending: 'is-pending',
                done: 'is-done',
                cancelled: 'is-muted',
                rejected: 'is-muted',
            }[value] || 'is-muted'
        );
    }

    bookingPillClass(value) {
        return (
            {
                approved: 'pill--available',
                pending: 'pill--pending',
                done: 'pill--ink',
                cancelled: 'pill--muted',
                rejected: 'pill--muted',
            }[value] || 'pill--muted'
        );
    }

    pendingInitials(booking) {
        return this._initials(booking.requested_by);
    }

    // ---------------------------------------------------------------------
    // Interacciones
    // ---------------------------------------------------------------------

    selectRoom(ev) {
        this.state.selectedRoomId = Number(ev.currentTarget.dataset.roomId);
    }

    onRoomSelect(ev) {
        this.state.selectedRoomId = Number(ev.currentTarget.value) || false;
    }

    onTimelineSlotClick(ev) {
        const hour = Number(ev.currentTarget.dataset.hour);
        if (!hour || !this.state.selectedRoomId) {
            return;
        }

        this.state.form.start = `${this.state.date}T${this._pad(hour)}:00`;
        this.state.form.stop = `${this.state.date}T${this._pad(hour + 1)}:00`;

        window.setTimeout(() => {
            const objective = document.querySelector('.o_aq_rooms .js-aq-objective');
            if (objective) {
                objective.focus();
            }
        }, 0);
    }

    async createQuickRequest() {
        if (!this.state.selectedRoomId) {
            this.notification.add('Selecciona una sala.', { type: 'warning' });
            return;
        }

        if (!this.hasObjective) {
            this.notification.add('Captura el objetivo de la reunión.', { type: 'warning' });
            return;
        }

        if (this.hasInvalidSlot) {
            this.notification.add('La hora de fin debe ser mayor que la de inicio.', { type: 'warning' });
            return;
        }

        if (this.quickConflicts.length) {
            this.notification.add('El horario cruza con otra reserva o solicitud pendiente.', { type: 'warning' });
            return;
        }

        const values = {
            room_id: this.state.selectedRoomId,
            start: this._normalizeDatetime(this.state.form.start),
            stop: this._normalizeDatetime(this.state.form.stop),
            objective: this.state.form.objective.trim(),
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
            context: {
                default_room_id: this.state.selectedRoomId,
                default_start: `${this.state.date} 09:00:00`,
                default_stop: `${this.state.date} 10:00:00`,
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
                this.state.date = this._dateFromDatetime(booking.start) || this.state.date;
                this._syncFormDate(this.state.date);
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
            await this.loadDashboard({ preferredRoomId: this.state.selectedRoomId });
        } catch (error) {
            this.notification.add(this._errorMessage(error, 'No fue posible rechazar.'), { type: 'danger' });
        }
    }
}

AqMeetingRoomsDashboard.template = 'aq_meeting_rooms.Dashboard';

registry.category('actions').add('aq_meeting_rooms.dashboard', AqMeetingRoomsDashboard);
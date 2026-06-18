/** @odoo-module **/

import { registry } from '@web/core/registry';
import { useService } from '@web/core/utils/hooks';
import { Component, onWillStart, useState } from '@odoo/owl';

const FIRST_HOUR = 8;
const LAST_HOUR = 20;
const WINDOW_MINUTES = (LAST_HOUR - FIRST_HOUR) * 60;

const DURATION_OPTIONS = [
    { minutes: 30, label: '30 min' },
    { minutes: 60, label: '1 h' },
    { minutes: 90, label: '1.5 h' },
    { minutes: 120, label: '2 h' },
];

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
            users: [],
            selectedRoomId: false,
            canApprove: false,
            date: today,
            lastUpdatedText: 'sin actualizar',
            participantQuery: '',
            form: {
                startTime: this._defaultStartTime(),
                duration: 60,
                objective: '',
                agenda: '',
                participants: [],
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

    _defaultStartTime() {
        const now = new Date();
        let minutes = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 30) * 30;
        minutes = Math.max(FIRST_HOUR * 60, Math.min(minutes, (LAST_HOUR - 1) * 60));
        return `${this._pad(Math.floor(minutes / 60))}:${this._pad(minutes % 60)}`;
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
            return LAST_HOUR * 60;
        }
        const stopMinute = this._minutesOfDay(booking.stop);
        if (stopMinute === 0 && this._dateFromDatetime(booking.start) !== bookingDate) {
            return LAST_HOUR * 60;
        }
        return stopMinute;
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

    formatTimeOption(slot) {
        const [hour, minute] = slot.split(':').map(Number);
        return this._formatClock(hour, minute);
    }

    get dateLong() {
        const date = this._dateObject(this.state.date);
        const days = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
        const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
        return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]}`;
    }

    get isToday() {
        return this.state.date === this._today();
    }

    get trackHours() {
        const hours = [];
        for (let hour = FIRST_HOUR; hour < LAST_HOUR; hour += 1) {
            hours.push(hour);
        }
        return hours;
    }

    get trackSlots() {
        const slots = [];
        for (let minutes = FIRST_HOUR * 60; minutes < LAST_HOUR * 60; minutes += 30) {
            slots.push(`${this._pad(Math.floor(minutes / 60))}:${this._pad(minutes % 60)}`);
        }
        return slots;
    }

    get nowLineStyle() {
        if (!this.isToday) {
            return '';
        }
        const now = new Date();
        const minutes = now.getHours() * 60 + now.getMinutes();
        const lowerBound = FIRST_HOUR * 60;
        const upperBound = LAST_HOUR * 60;
        if (minutes < lowerBound || minutes > upperBound) {
            return '';
        }
        const fraction = ((minutes - lowerBound) / WINDOW_MINUTES).toFixed(4);
        return `left: calc(var(--aqr-label-w) + (100% - var(--aqr-label-w)) * ${fraction});`;
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
            this.state.users = data.users || [];
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
        await this.loadDashboard({ preferredRoomId: this.state.selectedRoomId });
    }

    async changeDateBy(ev) {
        const days = Number(ev.currentTarget.dataset.day || 0);
        const date = this._dateObject(this.state.date);
        date.setDate(date.getDate() + days);

        this.state.date = `${date.getFullYear()}-${this._pad(date.getMonth() + 1)}-${this._pad(date.getDate())}`;
        await this.loadDashboard({ preferredRoomId: this.state.selectedRoomId });
    }

    async goToday() {
        if (this.isToday) {
            return;
        }
        this.state.date = this._today();
        await this.loadDashboard({ preferredRoomId: this.state.selectedRoomId });
    }

    // ---------------------------------------------------------------------
    // Derivados
    // ---------------------------------------------------------------------

    get selectedRoom() {
        return this.state.rooms.find((room) => room.id === this.state.selectedRoomId) || false;
    }

    get freeRoomsCount() {
        return this.state.rooms.filter((room) => this.roomDayStatus(room) === 'available').length;
    }

    get occupiedRoomsCount() {
        return this.state.rooms.filter((room) => this.roomDayStatus(room) === 'occupied').length;
    }

    get durationOptions() {
        return DURATION_OPTIONS;
    }

    get formStart() {
        return `${this.state.date} ${this.state.form.startTime}:00`;
    }

    get _formStopParts() {
        const [hour, minute] = this.state.form.startTime.split(':').map(Number);
        const total = hour * 60 + minute + this.state.form.duration;
        return { hour: Math.floor(total / 60), minute: total % 60 };
    }

    get formStop() {
        const { hour, minute } = this._formStopParts;
        return `${this.state.date} ${this._pad(hour)}:${this._pad(minute)}:00`;
    }

    get formStopLabel() {
        const { hour, minute } = this._formStopParts;
        return this._formatClock(hour, minute);
    }

    get hasObjective() {
        return Boolean((this.state.form.objective || '').trim());
    }

    get quickConflicts() {
        if (!this.state.selectedRoomId) {
            return [];
        }
        const start = this.formStart;
        const stop = this.formStop;

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

    roomTimelineBookings(roomId) {
        const lowerBound = FIRST_HOUR * 60;
        const upperBound = LAST_HOUR * 60;
        return this.roomBookings(roomId)
            .filter(
                (booking) =>
                    this._bookingStartMinute(booking) < upperBound &&
                    this._bookingStopMinute(booking) > lowerBound
            )
            .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
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

    timelineEventStyle(booking) {
        const lowerBound = FIRST_HOUR * 60;
        const upperBound = LAST_HOUR * 60;

        const startMinute = Math.max(lowerBound, this._bookingStartMinute(booking));
        const stopMinute = Math.min(upperBound, Math.max(startMinute + 15, this._bookingStopMinute(booking)));

        const left = ((startMinute - lowerBound) / WINDOW_MINUTES) * 100;
        const width = Math.max(((stopMinute - startMinute) / WINDOW_MINUTES) * 100, 2.5);

        return `left: ${left}%; width: ${width}%;`;
    }

    bookingRange(booking) {
        return `${this.formatTime(booking.start)}–${this.formatTime(booking.stop)}`;
    }

    bookingTooltip(booking) {
        return `${booking.objective || ''}\n${this.bookingRange(booking)} · ${booking.requested_by || ''}`;
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

    onSlotClick(ev) {
        const roomId = Number(ev.currentTarget.dataset.roomId);
        const time = ev.currentTarget.dataset.time;
        if (!roomId || !time) {
            return;
        }

        this.state.selectedRoomId = roomId;
        this.state.form.startTime = time;

        window.setTimeout(() => {
            const objective = document.querySelector('.o_aq_rooms .js-aq-objective');
            if (objective) {
                objective.focus();
            }
        }, 0);
    }

    setDuration(ev) {
        const minutes = Number(ev.currentTarget.dataset.minutes || 0);
        if (minutes) {
            this.state.form.duration = minutes;
        }
    }

    scrollToPending() {
        const panel = document.querySelector('.o_aq_rooms .js-aq-pending');
        if (panel) {
            panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
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

        if (this.quickConflicts.length) {
            this.notification.add('El horario cruza con otra reserva o solicitud pendiente.', { type: 'warning' });
            return;
        }

        const values = {
            room_id: this.state.selectedRoomId,
            start: this.formStart,
            stop: this.formStop,
            objective: this.state.form.objective.trim(),
            agenda: this.state.form.agenda,
            participant_user_ids: this.state.form.participants.map((user) => user.id),
        };

        try {
            const newBooking = await this.orm.call('aq.meeting.room.booking', 'dashboard_create_request', [values]);

            this.notification.add('Solicitud enviada para autorización.', { type: 'success' });

            this.state.form.objective = '';
            this.state.form.agenda = '';
            this.state.form.participants = [];
            this.state.participantQuery = '';

            if (newBooking && newBooking.start) {
                this.state.date = this._dateFromDatetime(newBooking.start) || this.state.date;
            }

            await this.loadDashboard({ preferredRoomId: this.state.selectedRoomId });
        } catch (error) {
            this.notification.add(this._errorMessage(error, 'No fue posible crear la solicitud.'), { type: 'danger' });
        }
    }

    // ---------------------------------------------------------------------
    // Invitados (usuarios internos)
    // ---------------------------------------------------------------------

    get filteredParticipants() {
        const query = (this.state.participantQuery || '').trim().toLowerCase();
        if (!query) {
            return [];
        }
        const selectedIds = this.state.form.participants.map((user) => user.id);
        return this.state.users
            .filter((user) => !selectedIds.includes(user.id))
            .filter((user) => (user.name || '').toLowerCase().includes(query))
            .slice(0, 8);
    }

    onParticipantSearch(ev) {
        this.state.participantQuery = ev.currentTarget.value || '';
    }

    addParticipant(ev) {
        const userId = Number(ev.currentTarget.dataset.userId);
        const user = this.state.users.find((candidate) => candidate.id === userId);
        if (user && !this.state.form.participants.some((selected) => selected.id === userId)) {
            this.state.form.participants.push(user);
        }
        this.state.participantQuery = '';
    }

    removeParticipant(ev) {
        const userId = Number(ev.currentTarget.dataset.userId);
        this.state.form.participants = this.state.form.participants.filter((user) => user.id !== userId);
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
                default_start: this.formStart,
                default_stop: this.formStop,
                default_objective: this.state.form.objective || false,
                default_agenda: this.state.form.agenda || false,
                default_participant_partner_ids: this.state.form.participants.map((user) => user.partner_id),
            },
        });
    }

    openRoomConfig() {
        this.action.doAction({
            type: 'ir.actions.act_window',
            name: 'Salas de juntas',
            res_model: 'aq.meeting.room',
            view_mode: 'list,form',
            views: [[false, 'list'], [false, 'form']],
            target: 'current',
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

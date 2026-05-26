from datetime import datetime, time

from odoo import api, fields, models, _


class AqMeetingRoom(models.Model):
    _name = 'aq.meeting.room'
    _description = 'Sala de juntas'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'sequence, name'

    name = fields.Char(string='Sala', required=True, tracking=True)
    code = fields.Char(string='Código', copy=False, tracking=True)
    active = fields.Boolean(default=True)
    sequence = fields.Integer(default=10)
    capacity = fields.Integer(string='Capacidad', default=6, tracking=True)
    location = fields.Char(string='Ubicación')
    equipment = fields.Text(string='Equipo disponible')
    description = fields.Html(string='Descripción')
    responsible_id = fields.Many2one('res.users', string='Responsable de sala', tracking=True)
    company_id = fields.Many2one('res.company', string='Compañía', default=lambda self: self.env.company, required=True)
    color = fields.Integer(string='Color calendario', default=0)
    image_1920 = fields.Image(string='Imagen')

    booking_ids = fields.One2many('aq.meeting.room.booking', 'room_id', string='Reservas')
    today_booking_count = fields.Integer(string='Reservas hoy', compute='_compute_booking_metrics')
    pending_booking_count = fields.Integer(string='Solicitudes pendientes', compute='_compute_booking_metrics')
    availability_state = fields.Selection(
        selection=[
            ('free', 'Disponible'),
            ('soon', 'Próxima reserva'),
            ('busy', 'Ocupada'),
        ],
        string='Estado actual',
        compute='_compute_booking_metrics',
    )
    current_booking_id = fields.Many2one('aq.meeting.room.booking', string='Reserva actual', compute='_compute_booking_metrics')
    next_booking_id = fields.Many2one('aq.meeting.room.booking', string='Siguiente reserva', compute='_compute_booking_metrics')

    @api.depends('booking_ids.state', 'booking_ids.start', 'booking_ids.stop')
    def _compute_booking_metrics(self):
        Booking = self.env['aq.meeting.room.booking']
        now = fields.Datetime.now()
        today = fields.Date.context_today(self)
        today_start = datetime.combine(today, time.min)
        today_stop = datetime.combine(today, time.max)
        soon_limit = fields.Datetime.add(now, hours=1)

        for room in self:
            today_domain = [
                ('room_id', '=', room.id),
                ('state', 'in', ['pending', 'approved', 'done']),
                ('start', '<=', today_stop),
                ('stop', '>=', today_start),
            ]
            pending_domain = [
                ('room_id', '=', room.id),
                ('state', '=', 'pending'),
            ]
            current = Booking.search([
                ('room_id', '=', room.id),
                ('state', '=', 'approved'),
                ('start', '<=', now),
                ('stop', '>', now),
            ], limit=1)
            next_booking = Booking.search([
                ('room_id', '=', room.id),
                ('state', '=', 'approved'),
                ('start', '>', now),
            ], order='start asc', limit=1)

            room.today_booking_count = Booking.search_count(today_domain)
            room.pending_booking_count = Booking.search_count(pending_domain)
            room.current_booking_id = current
            room.next_booking_id = next_booking
            if current:
                room.availability_state = 'busy'
            elif next_booking and next_booking.start <= soon_limit:
                room.availability_state = 'soon'
            else:
                room.availability_state = 'free'

    def action_open_bookings(self):
        self.ensure_one()
        return {
            'name': _('Reservas de %s') % self.name,
            'type': 'ir.actions.act_window',
            'res_model': 'aq.meeting.room.booking',
            'view_mode': 'calendar,list,form',
            'domain': [('room_id', '=', self.id)],
            'context': {'default_room_id': self.id},
        }

    @api.model
    def get_dashboard_data(self, date_from=None, date_to=None):
        """Return sanitized data for the OWL dashboard.

        The dashboard intentionally exposes room occupancy data to applicants so they can
        request valid meeting slots without needing full administrative permissions.
        """
        Booking = self.env['aq.meeting.room.booking']
        if date_from:
            date_from_dt = fields.Datetime.to_datetime(date_from)
        else:
            today = fields.Date.context_today(self)
            date_from_dt = datetime.combine(today, time.min)

        if date_to:
            date_to_dt = fields.Datetime.to_datetime(date_to)
        else:
            date_to_dt = fields.Datetime.add(date_from_dt, days=1)

        rooms = self.search([('active', '=', True)], order='sequence, name')
        booking_domain = [
            ('room_id', 'in', rooms.ids),
            ('state', 'in', ['pending', 'approved', 'done']),
            ('start', '<', date_to_dt),
            ('stop', '>', date_from_dt),
        ]
        bookings = Booking.search(booking_domain, order='start asc, room_id asc')

        can_approve = self.env.user.has_group('aq_meeting_rooms.group_meeting_room_approver')
        pending_domain = [('state', '=', 'pending')]
        if not can_approve:
            pending_domain.append(('requested_by_id', '=', self.env.user.id))
        pending_bookings = Booking.search(pending_domain, order='start asc', limit=30)

        my_open_bookings = Booking.search([
            ('requested_by_id', '=', self.env.user.id),
            ('state', 'in', ['draft', 'pending', 'approved']),
            ('stop', '>=', date_from_dt),
        ], order='start asc', limit=12)

        return {
            'can_approve': can_approve,
            'rooms': [room._dashboard_room_payload() for room in rooms],
            'bookings': [booking._dashboard_booking_payload() for booking in bookings],
            'pending_bookings': [booking._dashboard_booking_payload() for booking in pending_bookings],
            'my_open_bookings': [booking._dashboard_booking_payload() for booking in my_open_bookings],
            'date_from': fields.Datetime.to_string(date_from_dt),
            'date_to': fields.Datetime.to_string(date_to_dt),
            'server_now': fields.Datetime.to_string(fields.Datetime.now()),
        }

    def _dashboard_room_payload(self):
        self.ensure_one()
        return {
            'id': self.id,
            'name': self.name,
            'code': self.code or '',
            'capacity': self.capacity or 0,
            'location': self.location or '',
            'equipment': self.equipment or '',
            'responsible': self.responsible_id.display_name if self.responsible_id else '',
            'availability_state': self.availability_state,
            'availability_label': dict(self._fields['availability_state'].selection).get(self.availability_state),
            'today_booking_count': self.today_booking_count,
            'pending_booking_count': self.pending_booking_count,
            'current_booking_name': self.current_booking_id.name if self.current_booking_id else '',
            'current_booking_objective': self.current_booking_id.objective if self.current_booking_id else '',
            'next_booking_name': self.next_booking_id.name if self.next_booking_id else '',
            'next_booking_objective': self.next_booking_id.objective if self.next_booking_id else '',
            'next_booking_start': fields.Datetime.to_string(self.next_booking_id.start) if self.next_booking_id else '',
            'next_booking_stop': fields.Datetime.to_string(self.next_booking_id.stop) if self.next_booking_id else '',
            'image_url': '/web/image/aq.meeting.room/%s/image_1920' % self.id if self.image_1920 else '',
        }

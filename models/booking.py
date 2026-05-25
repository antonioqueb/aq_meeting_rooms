from odoo import api, fields, models, _
from odoo.exceptions import AccessError, UserError, ValidationError


class AqMeetingRoomBooking(models.Model):
    _name = 'aq.meeting.room.booking'
    _description = 'Solicitud de sala de juntas'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'start desc, id desc'

    name = fields.Char(string='Folio', required=True, copy=False, default='Nuevo', tracking=True)
    room_id = fields.Many2one('aq.meeting.room', string='Sala de juntas', required=True, tracking=True, index=True)
    requested_by_id = fields.Many2one(
        'res.users',
        string='Solicitante',
        required=True,
        default=lambda self: self.env.user,
        tracking=True,
    )
    approver_id = fields.Many2one('res.users', string='Autorizador', readonly=True, tracking=True)
    decision_date = fields.Datetime(string='Fecha de decisión', readonly=True)
    company_id = fields.Many2one(related='room_id.company_id', store=True, readonly=True)

    start = fields.Datetime(string='Inicio', required=True, tracking=True)
    stop = fields.Datetime(string='Fin', required=True, tracking=True)
    duration = fields.Float(string='Duración (h)', compute='_compute_duration', store=True)

    objective = fields.Char(string='Objetivo de la reunión', required=True, tracking=True)
    agenda = fields.Html(string='Agenda / contexto')
    participant_partner_ids = fields.Many2many(
        'res.partner',
        'aq_meeting_booking_partner_rel',
        'booking_id',
        'partner_id',
        string='Participantes',
    )
    notes = fields.Html(string='Notas internas')
    rejection_reason = fields.Text(string='Motivo de rechazo')
    cancel_reason = fields.Text(string='Motivo de cancelación')

    state = fields.Selection(
        selection=[
            ('draft', 'Borrador'),
            ('pending', 'Pendiente de autorización'),
            ('approved', 'Autorizada'),
            ('rejected', 'Rechazada'),
            ('cancelled', 'Cancelada'),
            ('done', 'Finalizada'),
        ],
        string='Estado',
        default='draft',
        tracking=True,
        required=True,
        index=True,
    )
    minute_ids = fields.One2many('aq.meeting.minute', 'booking_id', string='Minutas')
    minute_count = fields.Integer(string='Minutas', compute='_compute_minute_count')
    can_approve = fields.Boolean(string='Puede autorizar', compute='_compute_can_approve')

    @api.depends('start', 'stop')
    def _compute_duration(self):
        for booking in self:
            if booking.start and booking.stop:
                booking.duration = (booking.stop - booking.start).total_seconds() / 3600.0
            else:
                booking.duration = 0.0

    def _compute_minute_count(self):
        for booking in self:
            booking.minute_count = len(booking.minute_ids)

    def _compute_can_approve(self):
        can_approve = self.env.user.has_group('aq_meeting_rooms.group_meeting_room_approver')
        for booking in self:
            booking.can_approve = can_approve

    @api.constrains('start', 'stop', 'room_id', 'state')
    def _check_dates_and_conflicts(self):
        for booking in self:
            if booking.start and booking.stop and booking.start >= booking.stop:
                raise ValidationError(_('La fecha de fin debe ser mayor que la fecha de inicio.'))
            if booking.state == 'approved':
                booking._ensure_no_approved_conflict()

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', 'Nuevo') == 'Nuevo':
                vals['name'] = self.env['ir.sequence'].next_by_code('aq.meeting.room.booking') or 'Nuevo'
            if not vals.get('participant_partner_ids') and self.env.user.partner_id:
                vals['participant_partner_ids'] = [(6, 0, [self.env.user.partner_id.id])]
        return super().create(vals_list)


    def write(self, vals):
        protected_fields = {'room_id', 'start', 'stop', 'objective', 'participant_partner_ids'}
        if protected_fields.intersection(vals) and not self.env.user.has_group('aq_meeting_rooms.group_meeting_room_approver'):
            locked = self.filtered(lambda booking: booking.state not in ['draft', 'pending'])
            if locked:
                raise AccessError(_('Solo un autorizador puede modificar datos críticos de una reserva ya autorizada, rechazada, cancelada o finalizada.'))
        return super().write(vals)

    def _ensure_no_approved_conflict(self):
        self.ensure_one()
        if not self.room_id or not self.start or not self.stop:
            return
        conflict = self.search([
            ('id', '!=', self.id),
            ('room_id', '=', self.room_id.id),
            ('state', '=', 'approved'),
            ('start', '<', self.stop),
            ('stop', '>', self.start),
        ], limit=1)
        if conflict:
            raise ValidationError(_(
                'La sala %(room)s ya está autorizada para %(booking)s entre %(start)s y %(stop)s.'
            ) % {
                'room': self.room_id.display_name,
                'booking': conflict.display_name,
                'start': fields.Datetime.to_string(conflict.start),
                'stop': fields.Datetime.to_string(conflict.stop),
            })

    def _check_authorizer(self):
        if not self.env.user.has_group('aq_meeting_rooms.group_meeting_room_approver'):
            raise AccessError(_('No tienes permisos para autorizar o rechazar solicitudes de sala.'))

    def action_request(self):
        for booking in self:
            if booking.state not in ['draft', 'cancelled', 'rejected']:
                continue
            booking.write({'state': 'pending'})
            booking.message_post(body=_('Solicitud enviada para autorización.'))
        return True

    def action_approve(self):
        self._check_authorizer()
        for booking in self:
            if booking.state != 'pending':
                raise UserError(_('Solo puedes autorizar solicitudes pendientes.'))
            booking._ensure_no_approved_conflict()
            booking.write({
                'state': 'approved',
                'approver_id': self.env.user.id,
                'decision_date': fields.Datetime.now(),
            })
            partners = booking.participant_partner_ids | booking.requested_by_id.partner_id
            if partners:
                booking.message_subscribe(partner_ids=partners.ids)
            booking.message_post(body=_('Solicitud autorizada. La sala queda bloqueada para este horario.'))
        return True

    def action_reject(self):
        self._check_authorizer()
        for booking in self:
            if booking.state != 'pending':
                raise UserError(_('Solo puedes rechazar solicitudes pendientes.'))
            booking.write({
                'state': 'rejected',
                'approver_id': self.env.user.id,
                'decision_date': fields.Datetime.now(),
            })
            booking.message_post(body=_('Solicitud rechazada.'))
        return True

    def action_cancel(self):
        for booking in self:
            if booking.state in ['cancelled', 'done']:
                continue
            booking.write({'state': 'cancelled'})
            booking.message_post(body=_('Solicitud cancelada.'))
        return True

    def action_done(self):
        for booking in self:
            if booking.state != 'approved':
                raise UserError(_('Solo puedes finalizar una reserva autorizada.'))
            booking.write({'state': 'done'})
            if not booking.minute_ids:
                booking._create_default_minute()
            booking.message_post(body=_('Reunión finalizada.'))
        return True

    def _create_default_minute(self):
        self.ensure_one()
        return self.env['aq.meeting.minute'].create({
            'name': _('Minuta %s') % self.name,
            'booking_id': self.id,
            'capture_by_id': self.env.user.id,
            'participant_partner_ids': [(6, 0, self.participant_partner_ids.ids)],
        })

    def action_open_minute(self):
        self.ensure_one()
        if self.state not in ['approved', 'done']:
            raise UserError(_('La minuta se puede capturar cuando la reserva está autorizada o finalizada.'))
        minute = self.minute_ids[:1] or self._create_default_minute()
        return {
            'name': _('Minuta'),
            'type': 'ir.actions.act_window',
            'res_model': 'aq.meeting.minute',
            'res_id': minute.id,
            'view_mode': 'form',
            'target': 'current',
        }

    def action_view_minutes(self):
        self.ensure_one()
        return {
            'name': _('Minutas'),
            'type': 'ir.actions.act_window',
            'res_model': 'aq.meeting.minute',
            'view_mode': 'list,form',
            'domain': [('booking_id', '=', self.id)],
            'context': {'default_booking_id': self.id},
        }

    @api.model
    def dashboard_create_request(self, vals):
        room_id = vals.get('room_id')
        start = vals.get('start')
        stop = vals.get('stop')
        objective = vals.get('objective')
        if not room_id or not start or not stop or not objective:
            raise UserError(_('Completa sala, inicio, fin y objetivo para crear la solicitud.'))

        booking = self.create({
            'room_id': int(room_id),
            'start': fields.Datetime.to_datetime(start),
            'stop': fields.Datetime.to_datetime(stop),
            'objective': objective,
            'agenda': vals.get('agenda') or False,
            'requested_by_id': self.env.user.id,
        })
        booking.action_request()
        return booking._dashboard_booking_payload()

    def _dashboard_booking_payload(self):
        self.ensure_one()
        return {
            'id': self.id,
            'name': self.name,
            'room_id': self.room_id.id,
            'room_name': self.room_id.display_name,
            'requested_by': self.requested_by_id.display_name,
            'start': fields.Datetime.to_string(self.start) if self.start else '',
            'stop': fields.Datetime.to_string(self.stop) if self.stop else '',
            'duration': self.duration,
            'objective': self.objective or '',
            'state': self.state,
            'state_label': dict(self._fields['state'].selection).get(self.state),
            'participants_count': len(self.participant_partner_ids),
        }

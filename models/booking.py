import base64
import logging

from odoo import api, fields, models, _
from odoo.exceptions import AccessError, UserError, ValidationError
from odoo.tools import format_datetime, html2plaintext, html_escape

_logger = logging.getLogger(__name__)


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
    invitation_sent = fields.Boolean(string='Invitación enviada', readonly=True, copy=False, tracking=True)
    invitation_date = fields.Datetime(string='Fecha de invitación', readonly=True, copy=False)

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
            booking._validate_date_order()
            if booking.state == 'approved':
                booking._ensure_no_approved_conflict()
            elif booking.state == 'pending':
                booking._ensure_no_request_conflict()

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
                raise AccessError(_(
                    'Solo un autorizador puede modificar datos críticos de una reserva ya autorizada, '
                    'rechazada, cancelada o finalizada.'
                ))

        res = super().write(vals)

        conflict_fields = {'room_id', 'start', 'stop', 'state'}
        if conflict_fields.intersection(vals):
            for booking in self:
                booking._validate_date_order()
                if booking.state == 'approved':
                    booking._ensure_no_approved_conflict()
                elif booking.state == 'pending':
                    booking._ensure_no_request_conflict()
        return res

    def _validate_date_order(self):
        self.ensure_one()
        if self.start and self.stop and self.start >= self.stop:
            raise ValidationError(_('La fecha de fin debe ser mayor que la fecha de inicio.'))

    @api.model
    def _find_overlapping_booking(self, room_id, start, stop, states, exclude_id=False):
        if not room_id or not start or not stop:
            return self.browse()
        domain = [
            ('room_id', '=', room_id),
            ('state', 'in', states),
            ('start', '<', stop),
            ('stop', '>', start),
        ]
        if exclude_id:
            domain.append(('id', '!=', exclude_id))
        return self.search(domain, order='start asc', limit=1)

    def _ensure_no_request_conflict(self):
        self.ensure_one()
        if not self.room_id or not self.start or not self.stop:
            return
        conflict = self._find_overlapping_booking(
            self.room_id.id,
            self.start,
            self.stop,
            states=['pending', 'approved'],
            exclude_id=self.id,
        )
        if conflict:
            if conflict.state == 'approved':
                message = _(
                    'La sala %(room)s ya tiene una reserva autorizada (%(booking)s) entre %(start)s y %(stop)s.'
                )
            else:
                message = _(
                    'La sala %(room)s ya tiene una solicitud pendiente (%(booking)s) entre %(start)s y %(stop)s.'
                )
            raise ValidationError(message % {
                'room': self.room_id.display_name,
                'booking': conflict.display_name,
                'start': fields.Datetime.to_string(conflict.start),
                'stop': fields.Datetime.to_string(conflict.stop),
            })

    def _ensure_no_approved_conflict(self):
        self.ensure_one()
        if not self.room_id or not self.start or not self.stop:
            return
        conflict = self._find_overlapping_booking(
            self.room_id.id,
            self.start,
            self.stop,
            states=['approved'],
            exclude_id=self.id,
        )
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
            booking._validate_date_order()
            booking._ensure_no_request_conflict()
            booking.write({'state': 'pending'})
            booking.message_post(body=_('Solicitud enviada para autorización.'))
            booking._notify_approval_request()
        return True

    def action_approve(self):
        self._check_authorizer()
        for booking in self:
            if booking.state != 'pending':
                raise UserError(_('Solo puedes autorizar solicitudes pendientes.'))
            booking._validate_date_order()
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
            booking._send_invitation()
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
        minute = self.env['aq.meeting.minute'].create({
            'name': _('Minuta %s') % self.name,
            'booking_id': self.id,
            'capture_by_id': self.env.user.id,
            'chair_partner_id': self.requested_by_id.partner_id.id if self.requested_by_id.partner_id else False,
            'participant_partner_ids': [(6, 0, self.participant_partner_ids.ids)],
            'summary': self.agenda or False,
        })
        minute._seed_default_structure()
        return minute

    def action_open_minute(self):
        self.ensure_one()
        if self.state not in ['approved', 'done']:
            raise UserError(_('La minuta se puede capturar cuando la reserva está autorizada o finalizada.'))
        minute = self.minute_ids[:1] or self._create_default_minute()
        if not minute.line_ids:
            minute._seed_default_structure()
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

    # ------------------------------------------------------------------
    # Notificaciones por correo
    # ------------------------------------------------------------------
    def _get_approver_recipients(self):
        """Usuarios autorizadores y administradores activos con correo.

        El grupo de autorizadores incluye a los administradores (porque el grupo
        de administrador implica al de autorizador), por lo que basta con leer
        los usuarios del grupo de autorizadores.
        """
        self.ensure_one()
        group = self.env.ref('aq_meeting_rooms.group_meeting_room_approver', raise_if_not_found=False)
        if not group:
            return self.env['res.users']
        return group.users.filtered(lambda user: user.active and user.email)

    def _invitation_recipient_partners(self):
        self.ensure_one()
        partners = self.participant_partner_ids
        if self.requested_by_id.partner_id:
            partners |= self.requested_by_id.partner_id
        return partners.filtered(lambda partner: partner.email)

    def _booking_record_url(self):
        self.ensure_one()
        base_url = self.env['ir.config_parameter'].sudo().get_param('web.base.url')
        return '%s/web#id=%s&model=aq.meeting.room.booking&view_type=form' % (base_url, self.id)

    def _booking_detail_html(self):
        self.ensure_one()
        participants = ', '.join(self.participant_partner_ids.mapped('display_name')) or _('Sin participantes registrados')
        return """
            <ul>
                <li><strong>Folio:</strong> %s</li>
                <li><strong>Objetivo:</strong> %s</li>
                <li><strong>Sala:</strong> %s</li>
                <li><strong>Ubicación:</strong> %s</li>
                <li><strong>Inicio:</strong> %s</li>
                <li><strong>Fin:</strong> %s</li>
                <li><strong>Duración:</strong> %s h</li>
                <li><strong>Solicitante:</strong> %s</li>
                <li><strong>Participantes:</strong> %s</li>
            </ul>
        """ % (
            html_escape(self.name or ''),
            html_escape(self.objective or ''),
            html_escape(self.room_id.display_name or ''),
            html_escape(self.room_id.location or _('No especificada')),
            html_escape(format_datetime(self.env, self.start) if self.start else ''),
            html_escape(format_datetime(self.env, self.stop) if self.stop else ''),
            html_escape('%.2f' % (self.duration or 0.0)),
            html_escape(self.requested_by_id.display_name or ''),
            html_escape(participants),
        )

    def _notify_approval_request(self):
        for booking in self:
            recipients = booking._get_approver_recipients()
            emails = recipients.mapped('email')
            if not emails:
                _logger.info('No hay autorizadores con correo para la solicitud %s.', booking.name)
                continue
            subject = _('Nueva solicitud de sala por autorizar: %s') % (booking.objective or booking.name)
            body_html = """
                <p>Hola,</p>
                <p>Se registró una nueva solicitud de reserva de sala que requiere tu autorización.</p>
                %s
                <p>Atiende la solicitud en Odoo: <a href="%s">abrir solicitud</a>.</p>
            """ % (booking._booking_detail_html(), html_escape(booking._booking_record_url()))
            self.env['mail.mail'].sudo().create({
                'subject': subject,
                'body_html': body_html,
                'email_to': ','.join(emails),
                'auto_delete': True,
            }).send()
            booking.message_post(
                body=_('Aviso de autorización enviado a %s autorizador(es)/administrador(es).') % len(emails)
            )
        return True

    def _send_invitation(self, manual=False):
        for booking in self:
            if booking.state not in ('approved', 'done'):
                if manual:
                    raise UserError(_(
                        'La invitación solo puede enviarse cuando la reserva está autorizada o finalizada.'
                    ))
                continue
            partners = booking._invitation_recipient_partners()
            if not partners:
                if manual:
                    raise UserError(_('No hay participantes con correo electrónico para enviar la invitación.'))
                booking.message_post(
                    body=_('No se envió la invitación: ningún participante tiene correo electrónico.')
                )
                continue
            subject = _('Invitación a reunión: %s') % (booking.objective or booking.name)
            body_html = """
                <p>Hola,</p>
                <p>Has sido convocado(a) a la siguiente reunión. Se adjunta la invitación de calendario (.ics).</p>
                %s
                <p>Consulta el detalle en Odoo: <a href="%s">abrir reserva</a>.</p>
            """ % (booking._booking_detail_html(), html_escape(booking._booking_record_url()))
            attachment = booking._build_ics_attachment(partners)
            mail = self.env['mail.mail'].sudo().create({
                'subject': subject,
                'body_html': body_html,
                'email_to': ','.join(partners.mapped('email')),
                'attachment_ids': [(6, 0, attachment.ids)] if attachment else False,
                'auto_delete': True,
            })
            mail.send()
            booking.write({'invitation_sent': True, 'invitation_date': fields.Datetime.now()})
            booking.message_post(body=_('Invitación formal enviada a %s participante(s).') % len(partners))
        return True

    def action_send_invitation(self):
        return self._send_invitation(manual=True)

    def _build_ics_attachment(self, partners):
        self.ensure_one()
        if not self.start or not self.stop:
            return self.env['ir.attachment']

        def _ics_escape(value):
            return (value or '').replace('\\', '\\\\').replace(';', '\\;').replace(',', '\\,').replace('\n', '\\n')

        def _ics_dt(value):
            return value.strftime('%Y%m%dT%H%M%SZ')

        description_parts = [self.objective or '']
        if self.agenda:
            description_parts.append(html2plaintext(self.agenda))
        description = '\n'.join(part for part in description_parts if part)

        organizer = self.requested_by_id.partner_id or self.env.company.partner_id
        # SEQUENCE debe incrementarse en reenvíos para que el calendario actualice el evento.
        sequence = 1 if self.invitation_sent else 0
        lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Alphaqueb Consulting//Meeting Rooms//ES',
            'CALSCALE:GREGORIAN',
            'METHOD:REQUEST',
            'BEGIN:VEVENT',
            'UID:aq-meeting-booking-%s@%s' % (self.id, self.env.cr.dbname),
            'DTSTAMP:%s' % _ics_dt(fields.Datetime.now()),
            'DTSTART:%s' % _ics_dt(self.start),
            'DTEND:%s' % _ics_dt(self.stop),
            'SUMMARY:%s' % _ics_escape(self.objective or self.name),
            'DESCRIPTION:%s' % _ics_escape(description),
            'LOCATION:%s' % _ics_escape(self.room_id.location or self.room_id.display_name or ''),
            'STATUS:CONFIRMED',
            'SEQUENCE:%s' % sequence,
        ]
        if organizer.email:
            lines.append('ORGANIZER;CN=%s:mailto:%s' % (_ics_escape(organizer.name), organizer.email))
        for partner in partners:
            lines.append(
                'ATTENDEE;CN=%s;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:%s'
                % (_ics_escape(partner.name), partner.email)
            )
        lines += ['END:VEVENT', 'END:VCALENDAR']
        content = '\r\n'.join(lines)
        return self.env['ir.attachment'].sudo().create({
            'name': 'invitacion-%s.ics' % (self.name or str(self.id)).replace('/', '-'),
            'type': 'binary',
            'datas': base64.b64encode(content.encode('utf-8')),
            'res_model': self._name,
            'res_id': self.id,
            'mimetype': 'text/calendar;method=REQUEST',
        })

    @api.model
    def dashboard_create_request(self, vals):
        room_id = vals.get('room_id')
        start = vals.get('start')
        stop = vals.get('stop')
        objective = vals.get('objective')
        if not room_id or not start or not stop or not objective:
            raise UserError(_('Completa sala, inicio, fin y objetivo para crear la solicitud.'))

        room = self.env['aq.meeting.room'].browse(int(room_id)).exists()
        if not room or not room.active:
            raise UserError(_('La sala seleccionada no existe o está inactiva.'))

        start_dt = fields.Datetime.to_datetime(start)
        stop_dt = fields.Datetime.to_datetime(stop)
        if start_dt >= stop_dt:
            raise UserError(_('La fecha de fin debe ser mayor que la fecha de inicio.'))

        conflict = self._find_overlapping_booking(
            room.id,
            start_dt,
            stop_dt,
            states=['pending', 'approved'],
        )
        if conflict:
            raise UserError(_(
                'No se puede crear la solicitud. La sala %(room)s ya tiene %(state)s %(booking)s entre %(start)s y %(stop)s.'
            ) % {
                'room': room.display_name,
                'state': dict(conflict._fields['state'].selection).get(conflict.state, conflict.state).lower(),
                'booking': conflict.display_name,
                'start': fields.Datetime.to_string(conflict.start),
                'stop': fields.Datetime.to_string(conflict.stop),
            })

        partner_ids = self._resolve_participant_partner_ids(vals.get('participant_user_ids'))

        booking = self.create({
            'room_id': room.id,
            'start': start_dt,
            'stop': stop_dt,
            'objective': objective,
            'agenda': vals.get('agenda') or False,
            'requested_by_id': self.env.user.id,
            'participant_partner_ids': [(6, 0, partner_ids)],
        })
        booking.action_request()
        return booking._dashboard_booking_payload()

    @api.model
    def _resolve_participant_partner_ids(self, participant_user_ids):
        """Convierte los usuarios internos seleccionados en partners participantes.

        Siempre incluye al solicitante para que reciba la invitación formal.
        """
        partner_ids = []
        if participant_user_ids:
            user_ids = [int(uid) for uid in participant_user_ids]
            users = self.env['res.users'].sudo().browse(user_ids).exists()
            partner_ids = users.partner_id.ids
        requester_partner = self.env.user.partner_id
        if requester_partner and requester_partner.id not in partner_ids:
            partner_ids.append(requester_partner.id)
        return partner_ids

    def _dashboard_booking_payload(self):
        self.ensure_one()
        state_labels = dict(self._fields['state'].selection)
        return {
            'id': self.id,
            'name': self.name,
            'room_id': self.room_id.id,
            'room_name': self.room_id.display_name,
            'requested_by': self.requested_by_id.display_name,
            'start': fields.Datetime.to_string(self.start) if self.start else '',
            'stop': fields.Datetime.to_string(self.stop) if self.stop else '',
            'duration': round(self.duration or 0.0, 2),
            'objective': self.objective or '',
            'agenda': self.agenda or '',
            'state': self.state,
            'state_label': state_labels.get(self.state, self.state),
            'participants_count': len(self.participant_partner_ids),
            'can_open_minute': self.state in ['approved', 'done'],
            'has_minute': bool(self.minute_ids),
            'minute_count': len(self.minute_ids),
        }

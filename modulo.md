## ./__init__.py
```py
from . import models
```

## ./__manifest__.py
```py
{
    'name': 'Alphaqueb Meeting Rooms',
    'version': '18.0.1.5.0',
    'summary': 'Reservación de salas de juntas, aprobaciones y minutas corporativas',
    'description': '''
Gestión integral de salas de juntas para Odoo 18.

Incluye:
- Catálogo de salas de juntas.
- Solicitudes de reserva con disponibilidad por sala.
- Flujo de autorización por solicitantes, autorizadores y administradores.
- Dashboard OWL moderno para visualizar salas, disponibilidad y solicitudes pendientes.
- Captura manual de minutas corporativas con estructura jerárquica.
- Reporte PDF de minuta y envío por correo a participantes.
- Aviso por correo a autorizadores y administradores cuando llega una nueva solicitud.
- Invitación formal por correo (con archivo .ics de calendario) a todos los participantes al autorizar la sesión.
- Selección de invitados (usuarios internos) desde la solicitud rápida del dashboard.
    ''',
    'category': 'Productivity',
    'author': 'Alphaqueb Consulting S.A.S.',
    'website': 'https://alphaqueb.com',
    'license': 'LGPL-3',
    'depends': ['base', 'mail', 'web'],
    'data': [
        'security/security.xml',
        'security/ir.model.access.csv',
        'data/sequence.xml',
        'views/dashboard_action.xml',
        'views/room_views.xml',
        'views/booking_views.xml',
        'views/minute_views.xml',
        'views/menu_views.xml',
        'reports/report_minute.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'aq_meeting_rooms/static/src/scss/dashboard.scss',
            'aq_meeting_rooms/static/src/scss/minute.scss',
            'aq_meeting_rooms/static/src/js/dashboard.js',
            'aq_meeting_rooms/static/src/xml/dashboard.xml',
        ],
    },
    'installable': True,
    'application': True,
    'auto_install': False,
}
```

## ./data/sequence.xml
```xml
<?xml version="1.0" encoding="UTF-8"?>
<odoo noupdate="1">
    <record id="seq_aq_meeting_room_booking" model="ir.sequence">
        <field name="name">Reserva de sala</field>
        <field name="code">aq.meeting.room.booking</field>
        <field name="prefix">SJR/%(year)s/</field>
        <field name="padding">5</field>
        <field name="company_id" eval="False"/>
    </record>

    <record id="seq_aq_meeting_minute" model="ir.sequence">
        <field name="name">Minuta corporativa</field>
        <field name="code">aq.meeting.minute</field>
        <field name="prefix">MIN/%(year)s/</field>
        <field name="padding">5</field>
        <field name="company_id" eval="False"/>
    </record>
</odoo>
```

## ./models/__init__.py
```py
from . import room
from . import booking
from . import minute
```

## ./models/booking.py
```py
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
```

## ./models/minute.py
```py
import base64
import logging

from odoo import api, fields, models, _
from odoo.exceptions import UserError, ValidationError
from odoo.tools import html_escape

_logger = logging.getLogger(__name__)


class AqMeetingMinute(models.Model):
    _name = 'aq.meeting.minute'
    _description = 'Minuta corporativa'
    _inherit = ['mail.thread', 'mail.activity.mixin']
    _order = 'meeting_start desc, id desc'

    _sql_constraints = [
        ('booking_unique', 'unique(booking_id)', 'Cada reserva solo puede tener una minuta principal.'),
    ]

    name = fields.Char(string='Minuta', required=True, copy=False, default='Nueva', tracking=True)
    booking_id = fields.Many2one('aq.meeting.room.booking', string='Reserva', required=True, ondelete='cascade', tracking=True)
    room_id = fields.Many2one(related='booking_id.room_id', string='Sala', store=True, readonly=True)
    objective = fields.Char(related='booking_id.objective', string='Objetivo', store=True, readonly=True)
    meeting_start = fields.Datetime(related='booking_id.start', string='Inicio', store=True, readonly=True)
    meeting_stop = fields.Datetime(related='booking_id.stop', string='Fin', store=True, readonly=True)
    requested_by_id = fields.Many2one(related='booking_id.requested_by_id', string='Solicitante', store=True, readonly=True)
    capture_by_id = fields.Many2one('res.users', string='Capturó', default=lambda self: self.env.user, required=True, tracking=True)
    chair_partner_id = fields.Many2one('res.partner', string='Líder de reunión')
    participant_partner_ids = fields.Many2many(
        'res.partner',
        'aq_meeting_minute_partner_rel',
        'minute_id',
        'partner_id',
        string='Participantes',
    )
    summary = fields.Html(string='Resumen ejecutivo')
    agreements_summary = fields.Html(string='Acuerdos generales')
    risk_notes = fields.Html(string='Riesgos / bloqueos')
    line_ids = fields.One2many('aq.meeting.minute.line', 'minute_id', string='Estructura de minuta')
    section_line_ids = fields.One2many(
        'aq.meeting.minute.line',
        'minute_id',
        string='Secciones',
        domain=[('item_type', '=', 'section')],
    )
    note_line_ids = fields.One2many(
        'aq.meeting.minute.line',
        'minute_id',
        string='Puntos tratados',
        domain=[('item_type', '=', 'note')],
    )
    agreement_line_ids = fields.One2many(
        'aq.meeting.minute.line',
        'minute_id',
        string='Acuerdos',
        domain=[('item_type', '=', 'agreement')],
    )
    decision_line_ids = fields.One2many(
        'aq.meeting.minute.line',
        'minute_id',
        string='Decisiones',
        domain=[('item_type', '=', 'decision')],
    )
    task_line_ids = fields.One2many(
        'aq.meeting.minute.line',
        'minute_id',
        string='Tareas',
        domain=[('item_type', '=', 'task')],
    )
    risk_line_ids = fields.One2many(
        'aq.meeting.minute.line',
        'minute_id',
        string='Riesgos',
        domain=[('item_type', '=', 'risk')],
    )
    line_count = fields.Integer(string='Líneas', compute='_compute_line_count')
    shared_date = fields.Datetime(string='Fecha de envío', readonly=True)
    state = fields.Selection(
        selection=[
            ('draft', 'Borrador'),
            ('confirmed', 'Confirmada'),
            ('shared', 'Compartida'),
        ],
        string='Estado',
        default='draft',
        tracking=True,
        required=True,
    )

    def _compute_line_count(self):
        for minute in self:
            minute.line_count = len(minute.line_ids)

    def get_report_line_ids(self):
        self.ensure_one()
        return self.line_ids.sorted(key=lambda line: (line.sequence, line.parent_path or '', line.id))

    def get_report_line_ids_by_type(self, item_type):
        self.ensure_one()
        return self.line_ids.filtered(lambda line: line.item_type == item_type).sorted(
            key=lambda line: (line.sequence, line.parent_path or '', line.id)
        )

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', 'Nueva') == 'Nueva':
                vals['name'] = self.env['ir.sequence'].next_by_code('aq.meeting.minute') or 'Nueva'
            if vals.get('booking_id') and not vals.get('participant_partner_ids'):
                booking = self.env['aq.meeting.room.booking'].browse(vals['booking_id'])
                vals['participant_partner_ids'] = [(6, 0, booking.participant_partner_ids.ids)]
            if vals.get('booking_id') and not vals.get('chair_partner_id'):
                booking = self.env['aq.meeting.room.booking'].browse(vals['booking_id'])
                vals['chair_partner_id'] = booking.requested_by_id.partner_id.id if booking.requested_by_id.partner_id else False
        return super().create(vals_list)

    def _seed_default_structure(self):
        Line = self.env['aq.meeting.minute.line']
        for minute in self:
            if minute.line_ids:
                continue

            section_context = Line.create({
                'minute_id': minute.id,
                'sequence': 10,
                'item_type': 'section',
                'name': _('1. Contexto y objetivo'),
                'description': _('Objetivo, alcance y motivo principal de la reunión.'),
            })
            Line.create({
                'minute_id': minute.id,
                'sequence': 20,
                'parent_id': section_context.id,
                'item_type': 'note',
                'name': _('Objetivo revisado'),
                'description': _('Resume qué se esperaba resolver o definir durante la reunión.'),
            })

            section_topics = Line.create({
                'minute_id': minute.id,
                'sequence': 30,
                'item_type': 'section',
                'name': _('2. Temas tratados'),
                'description': _('Puntos discutidos durante la sesión.'),
            })
            Line.create({
                'minute_id': minute.id,
                'sequence': 40,
                'parent_id': section_topics.id,
                'item_type': 'note',
                'name': _('Tema tratado'),
                'description': _('Describe el tema revisado, datos relevantes y conclusiones parciales.'),
            })

            section_decisions = Line.create({
                'minute_id': minute.id,
                'sequence': 50,
                'item_type': 'section',
                'name': _('3. Acuerdos y decisiones'),
                'description': _('Compromisos aceptados y decisiones tomadas.'),
            })
            Line.create({
                'minute_id': minute.id,
                'sequence': 60,
                'parent_id': section_decisions.id,
                'item_type': 'agreement',
                'name': _('Acuerdo principal'),
                'description': _('Registra el acuerdo con redacción clara y verificable.'),
            })
            Line.create({
                'minute_id': minute.id,
                'sequence': 70,
                'parent_id': section_decisions.id,
                'item_type': 'decision',
                'name': _('Decisión tomada'),
                'description': _('Registra la decisión, criterio aplicado y alcance.'),
            })

            section_tasks = Line.create({
                'minute_id': minute.id,
                'sequence': 80,
                'item_type': 'section',
                'name': _('4. Tareas y seguimiento'),
                'description': _('Acciones asignadas con responsable, fecha compromiso y estado.'),
            })
            Line.create({
                'minute_id': minute.id,
                'sequence': 90,
                'parent_id': section_tasks.id,
                'item_type': 'task',
                'name': _('Acción pendiente'),
                'description': _('Describe la acción concreta que debe ejecutarse.'),
                'task_state': 'todo',
            })

            section_risks = Line.create({
                'minute_id': minute.id,
                'sequence': 100,
                'item_type': 'section',
                'name': _('5. Riesgos y bloqueos'),
                'description': _('Riesgos, dependencias o bloqueos detectados.'),
            })
            Line.create({
                'minute_id': minute.id,
                'sequence': 110,
                'parent_id': section_risks.id,
                'item_type': 'risk',
                'name': _('Riesgo / bloqueo'),
                'description': _('Describe el riesgo, impacto posible y mitigación sugerida.'),
            })

            Line.create({
                'minute_id': minute.id,
                'sequence': 120,
                'item_type': 'section',
                'name': _('6. Cierre'),
                'description': _('Conclusión de la sesión y próximos pasos generales.'),
            })
        return True

    def action_seed_structure(self):
        for minute in self:
            if minute.line_ids:
                raise UserError(_('La minuta ya contiene líneas. Si necesitas ajustar la estructura, edita las secciones existentes.'))
        self._seed_default_structure()
        return True

    def action_confirm(self):
        for minute in self:
            if not minute.line_ids and not minute.summary:
                raise UserError(_('Captura al menos un resumen o una línea de minuta antes de confirmar.'))
            minute.write({'state': 'confirmed'})
            minute.message_post(body=_('Minuta confirmada.'))
        return True

    def action_reset_draft(self):
        self.write({'state': 'draft'})
        return True

    def action_print_minute(self):
        self.ensure_one()
        return self.env.ref('aq_meeting_rooms.action_report_meeting_minute').report_action(self)

    def action_share_by_email(self):
        for minute in self:
            partners = minute.participant_partner_ids.filtered(lambda partner: partner.email)
            if not partners:
                raise UserError(_('No hay participantes con correo electrónico para compartir la minuta.'))
            attachment_ids = minute._build_pdf_attachment_ids()
            base_url = self.env['ir.config_parameter'].sudo().get_param('web.base.url')
            record_url = '%s/web#id=%s&model=aq.meeting.minute&view_type=form' % (base_url, minute.id)
            subject = _('Minuta de reunión: %s') % (minute.booking_id.objective or minute.name)
            body_html = """
                <p>Hola,</p>
                <p>Se comparte la minuta de la reunión <strong>%s</strong>.</p>
                <ul>
                    <li><strong>Sala:</strong> %s</li>
                    <li><strong>Inicio:</strong> %s</li>
                    <li><strong>Fin:</strong> %s</li>
                </ul>
                <p>Consulta el registro en Odoo: <a href="%s">abrir minuta</a>.</p>
            """ % (
                html_escape(minute.booking_id.objective or minute.name),
                html_escape(minute.room_id.display_name or ''),
                html_escape(fields.Datetime.to_string(minute.meeting_start) if minute.meeting_start else ''),
                html_escape(fields.Datetime.to_string(minute.meeting_stop) if minute.meeting_stop else ''),
                html_escape(record_url),
            )
            mail = self.env['mail.mail'].sudo().create({
                'subject': subject,
                'body_html': body_html,
                'email_to': ','.join(partners.mapped('email')),
                'attachment_ids': [(6, 0, attachment_ids)],
            })
            mail.send()
            minute.write({'state': 'shared', 'shared_date': fields.Datetime.now()})
            minute.message_post(body=_('Minuta compartida por correo con los participantes.'))
        return True

    def _build_pdf_attachment_ids(self):
        self.ensure_one()
        attachment_ids = []
        try:
            pdf_content, _content_type = self.env['ir.actions.report'].sudo()._render_qweb_pdf(
                'aq_meeting_rooms.action_report_meeting_minute',
                [self.id],
            )
            attachment = self.env['ir.attachment'].sudo().create({
                'name': '%s.pdf' % self.name.replace('/', '-'),
                'type': 'binary',
                'datas': base64.b64encode(pdf_content),
                'res_model': self._name,
                'res_id': self.id,
                'mimetype': 'application/pdf',
            })
            attachment_ids.append(attachment.id)
        except Exception:
            _logger.exception('No fue posible adjuntar el PDF de la minuta %s.', self.id)
        return attachment_ids


class AqMeetingMinuteLine(models.Model):
    _name = 'aq.meeting.minute.line'
    _description = 'Línea de minuta corporativa'
    _parent_name = 'parent_id'
    _parent_store = True
    _order = 'sequence, parent_path, id'

    minute_id = fields.Many2one('aq.meeting.minute', string='Minuta', required=True, ondelete='cascade', index=True)
    sequence = fields.Integer(default=10)
    parent_id = fields.Many2one(
        'aq.meeting.minute.line',
        string='Elemento padre',
        index=True,
        domain="[('minute_id', '=', minute_id)]",
    )
    parent_path = fields.Char(index=True)
    child_ids = fields.One2many('aq.meeting.minute.line', 'parent_id', string='Subelementos')
    item_type = fields.Selection(
        selection=[
            ('section', 'Sección'),
            ('note', 'Punto tratado'),
            ('agreement', 'Acuerdo'),
            ('decision', 'Decisión'),
            ('task', 'Tarea'),
            ('risk', 'Riesgo'),
        ],
        string='Tipo',
        required=True,
        default='note',
    )
    name = fields.Char(string='Título', required=True)
    description = fields.Html(string='Detalle')
    responsible_partner_id = fields.Many2one('res.partner', string='Responsable')
    due_date = fields.Date(string='Fecha compromiso')
    priority = fields.Selection(
        selection=[
            ('0', 'Baja'),
            ('1', 'Normal'),
            ('2', 'Alta'),
            ('3', 'Crítica'),
        ],
        string='Prioridad',
        default='1',
    )
    task_state = fields.Selection(
        selection=[
            ('todo', 'Por hacer'),
            ('in_progress', 'En proceso'),
            ('done', 'Realizada'),
            ('blocked', 'Bloqueada'),
        ],
        string='Estado tarea',
        default='todo',
    )
    depth = fields.Integer(string='Nivel', compute='_compute_depth')


    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            item_type = vals.get('item_type')
            if item_type and item_type != 'task':
                vals['task_state'] = False
        return super().create(vals_list)

    def write(self, vals):
        clean_vals = dict(vals)
        if clean_vals.get('item_type') and clean_vals.get('item_type') != 'task' and 'task_state' not in clean_vals:
            clean_vals['task_state'] = False
        return super().write(clean_vals)

    @api.depends('parent_id')
    def _compute_depth(self):
        for line in self:
            depth = 0
            parent = line.parent_id
            while parent:
                depth += 1
                parent = parent.parent_id
            line.depth = depth

    @api.onchange('item_type')
    def _onchange_item_type(self):
        for line in self:
            if line.item_type != 'task':
                line.task_state = False

    @api.constrains('parent_id', 'minute_id')
    def _check_parent_minute(self):
        for line in self:
            if line.parent_id and line.parent_id.minute_id != line.minute_id:
                raise ValidationError(_('El elemento padre debe pertenecer a la misma minuta.'))
```

## ./models/room.py
```py
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

        internal_users = self.env['res.users'].sudo().search(
            [('share', '=', False), ('active', '=', True)],
            order='name',
        )

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
            'users': [
                {'id': user.id, 'name': user.display_name, 'partner_id': user.partner_id.id}
                for user in internal_users if user.partner_id
            ],
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
```

## ./reports/report_minute.xml
```xml
<?xml version="1.0" encoding="UTF-8"?>
<odoo>
    <record id="action_report_meeting_minute" model="ir.actions.report">
        <field name="name">Minuta de reunión</field>
        <field name="model">aq.meeting.minute</field>
        <field name="report_type">qweb-pdf</field>
        <field name="report_name">aq_meeting_rooms.report_meeting_minute_document</field>
        <field name="report_file">aq_meeting_rooms.report_meeting_minute_document</field>
        <field name="print_report_name">'Minuta - %s' % (object.name)</field>
        <field name="binding_model_id" ref="model_aq_meeting_minute"/>
        <field name="binding_type">report</field>
    </record>

    <template id="report_meeting_minute_document">
        <t t-call="web.html_container">
            <t t-foreach="docs" t-as="doc">
                <t t-call="web.external_layout">
                    <div class="page">
                        <style>
                            .aq-minute-title { font-size: 24px; font-weight: 800; margin-bottom: 6px; }
                            .aq-minute-subtitle { color: #555; font-size: 12px; margin-bottom: 18px; }
                            .aq-box { border: 1px solid #d9d9d9; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
                            .aq-label { color: #666; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
                            .aq-value { font-size: 13px; font-weight: 600; }
                            .aq-section-title { font-size: 15px; font-weight: 800; margin: 18px 0 8px 0; }
                            .aq-table { width: 100%; border-collapse: collapse; }
                            .aq-table th { background: #111; color: #fff; padding: 8px; font-size: 11px; }
                            .aq-table td { border-bottom: 1px solid #e5e5e5; padding: 7px; font-size: 11px; vertical-align: top; }
                            .aq-pill { display: inline-block; padding: 2px 7px; border-radius: 999px; border: 1px solid #ccc; font-size: 10px; }
                        </style>

                        <div class="aq-minute-title">Minuta de reunión</div>
                        <div class="aq-minute-subtitle">
                            <span t-field="doc.name"/> · <span t-field="doc.state"/>
                        </div>

                        <div class="row aq-box">
                            <div class="col-6">
                                <div class="aq-label">Objetivo</div>
                                <div class="aq-value"><span t-field="doc.booking_id.objective"/></div>
                            </div>
                            <div class="col-3">
                                <div class="aq-label">Sala</div>
                                <div class="aq-value"><span t-field="doc.room_id"/></div>
                            </div>
                            <div class="col-3">
                                <div class="aq-label">Solicitante</div>
                                <div class="aq-value"><span t-field="doc.requested_by_id"/></div>
                            </div>
                        </div>

                        <div class="row aq-box">
                            <div class="col-3">
                                <div class="aq-label">Inicio</div>
                                <div class="aq-value"><span t-field="doc.meeting_start"/></div>
                            </div>
                            <div class="col-3">
                                <div class="aq-label">Fin</div>
                                <div class="aq-value"><span t-field="doc.meeting_stop"/></div>
                            </div>
                            <div class="col-3">
                                <div class="aq-label">Capturó</div>
                                <div class="aq-value"><span t-field="doc.capture_by_id"/></div>
                            </div>
                            <div class="col-3">
                                <div class="aq-label">Líder</div>
                                <div class="aq-value"><span t-field="doc.chair_partner_id"/></div>
                            </div>
                        </div>

                        <div class="aq-section-title">Participantes</div>
                        <div class="aq-box">
                            <t t-if="doc.participant_partner_ids">
                                <t t-foreach="doc.participant_partner_ids" t-as="partner">
                                    <span class="aq-pill"><span t-field="partner.display_name"/></span>
                                </t>
                            </t>
                            <t t-else="">
                                <span class="text-muted">Sin participantes capturados.</span>
                            </t>
                        </div>

                        <t t-if="doc.summary">
                            <div class="aq-section-title">Resumen ejecutivo</div>
                            <div class="aq-box"><span t-field="doc.summary"/></div>
                        </t>

                        <t t-if="doc.agreements_summary">
                            <div class="aq-section-title">Acuerdos generales</div>
                            <div class="aq-box"><span t-field="doc.agreements_summary"/></div>
                        </t>

                        <t t-if="doc.risk_notes">
                            <div class="aq-section-title">Riesgos / bloqueos</div>
                            <div class="aq-box"><span t-field="doc.risk_notes"/></div>
                        </t>

                        <div class="aq-section-title">Detalle de minuta</div>
                        <table class="aq-table">
                            <thead>
                                <tr>
                                    <th style="width: 14%;">Tipo</th>
                                    <th style="width: 34%;">Punto</th>
                                    <th style="width: 20%;">Detalle</th>
                                    <th style="width: 16%;">Responsable</th>
                                    <th style="width: 8%;">Fecha</th>
                                    <th style="width: 8%;">Estado</th>
                                </tr>
                            </thead>
                            <tbody>
                                <t t-if="doc.line_ids">
                                    <tr t-foreach="doc.get_report_line_ids()" t-as="line">
                                        <td><span t-field="line.item_type"/></td>
                                        <td>
                                            <div t-attf-style="margin-left: #{line.depth * 16}px;">
                                                <strong t-if="line.item_type == 'section'"><span t-field="line.name"/></strong>
                                                <span t-else="" t-field="line.name"/>
                                            </div>
                                        </td>
                                        <td><span t-field="line.description"/></td>
                                        <td><span t-field="line.responsible_partner_id"/></td>
                                        <td><span t-field="line.due_date"/></td>
                                        <td><span t-field="line.task_state"/></td>
                                    </tr>
                                </t>
                                <t t-else="">
                                    <tr>
                                        <td colspan="6" class="text-muted">Sin líneas capturadas.</td>
                                    </tr>
                                </t>
                            </tbody>
                        </table>
                    </div>
                </t>
            </t>
        </t>
    </template>
</odoo>
```

## ./security/security.xml
```xml
<?xml version="1.0" encoding="UTF-8"?>
<odoo>
    <record id="module_category_aq_meeting_rooms" model="ir.module.category">
        <field name="name">Salas de juntas</field>
        <field name="description">Reservas, autorizaciones y minutas corporativas</field>
        <field name="sequence">45</field>
    </record>

    <record id="group_meeting_room_applicant" model="res.groups">
        <field name="name">Solicitante</field>
        <field name="category_id" ref="module_category_aq_meeting_rooms"/>
        <field name="comment">Puede consultar disponibilidad, crear solicitudes y capturar minutas de sus reuniones.</field>
    </record>

    <record id="group_meeting_room_approver" model="res.groups">
        <field name="name">Autorizador</field>
        <field name="category_id" ref="module_category_aq_meeting_rooms"/>
        <field name="implied_ids" eval="[(4, ref('group_meeting_room_applicant'))]"/>
        <field name="comment">Puede autorizar, rechazar y gestionar solicitudes de salas.</field>
    </record>

    <record id="group_meeting_room_manager" model="res.groups">
        <field name="name">Administrador general</field>
        <field name="category_id" ref="module_category_aq_meeting_rooms"/>
        <field name="implied_ids" eval="[(4, ref('group_meeting_room_approver'))]"/>
        <field name="comment">Puede administrar salas, solicitudes, minutas y configuración del módulo.</field>
    </record>

    <!-- Reservas: lectura amplia para que los usuarios puedan ver disponibilidad real. -->
    <record id="rule_booking_applicant_read_all" model="ir.rule">
        <field name="name">Reservas - lectura de disponibilidad</field>
        <field name="model_id" ref="model_aq_meeting_room_booking"/>
        <field name="domain_force">[(1, '=', 1)]</field>
        <field name="groups" eval="[(4, ref('group_meeting_room_applicant'))]"/>
        <field name="perm_read" eval="True"/>
        <field name="perm_write" eval="False"/>
        <field name="perm_create" eval="False"/>
        <field name="perm_unlink" eval="False"/>
    </record>

    <record id="rule_booking_applicant_create" model="ir.rule">
        <field name="name">Reservas - crear solicitudes</field>
        <field name="model_id" ref="model_aq_meeting_room_booking"/>
        <field name="domain_force">[(1, '=', 1)]</field>
        <field name="groups" eval="[(4, ref('group_meeting_room_applicant'))]"/>
        <field name="perm_read" eval="False"/>
        <field name="perm_write" eval="False"/>
        <field name="perm_create" eval="True"/>
        <field name="perm_unlink" eval="False"/>
    </record>

    <record id="rule_booking_applicant_write_own_open" model="ir.rule">
        <field name="name">Reservas - editar propias activas</field>
        <field name="model_id" ref="model_aq_meeting_room_booking"/>
        <field name="domain_force">[('requested_by_id', '=', user.id), ('state', 'in', ['draft', 'pending', 'approved'])]</field>
        <field name="groups" eval="[(4, ref('group_meeting_room_applicant'))]"/>
        <field name="perm_read" eval="False"/>
        <field name="perm_write" eval="True"/>
        <field name="perm_create" eval="False"/>
        <field name="perm_unlink" eval="False"/>
    </record>

    <record id="rule_booking_approver_write_all" model="ir.rule">
        <field name="name">Reservas - autorizadores gestionan todas</field>
        <field name="model_id" ref="model_aq_meeting_room_booking"/>
        <field name="domain_force">[(1, '=', 1)]</field>
        <field name="groups" eval="[(4, ref('group_meeting_room_approver'))]"/>
        <field name="perm_read" eval="True"/>
        <field name="perm_write" eval="True"/>
        <field name="perm_create" eval="True"/>
        <field name="perm_unlink" eval="False"/>
    </record>

    <record id="rule_booking_manager_all" model="ir.rule">
        <field name="name">Reservas - administrador general</field>
        <field name="model_id" ref="model_aq_meeting_room_booking"/>
        <field name="domain_force">[(1, '=', 1)]</field>
        <field name="groups" eval="[(4, ref('group_meeting_room_manager'))]"/>
        <field name="perm_read" eval="True"/>
        <field name="perm_write" eval="True"/>
        <field name="perm_create" eval="True"/>
        <field name="perm_unlink" eval="True"/>
    </record>

    <!-- Minutas: los participantes y solicitantes pueden consultarlas; la captura queda controlada por estado. -->
    <record id="rule_minute_applicant_read_related" model="ir.rule">
        <field name="name">Minutas - lectura relacionada</field>
        <field name="model_id" ref="model_aq_meeting_minute"/>
        <field name="domain_force">['|', '|', ('capture_by_id', '=', user.id), ('booking_id.requested_by_id', '=', user.id), ('participant_partner_ids', 'in', [user.partner_id.id])]</field>
        <field name="groups" eval="[(4, ref('group_meeting_room_applicant'))]"/>
        <field name="perm_read" eval="True"/>
        <field name="perm_write" eval="False"/>
        <field name="perm_create" eval="False"/>
        <field name="perm_unlink" eval="False"/>
    </record>

    <record id="rule_minute_applicant_create" model="ir.rule">
        <field name="name">Minutas - crear</field>
        <field name="model_id" ref="model_aq_meeting_minute"/>
        <field name="domain_force">[(1, '=', 1)]</field>
        <field name="groups" eval="[(4, ref('group_meeting_room_applicant'))]"/>
        <field name="perm_read" eval="False"/>
        <field name="perm_write" eval="False"/>
        <field name="perm_create" eval="True"/>
        <field name="perm_unlink" eval="False"/>
    </record>

    <record id="rule_minute_applicant_write_draft" model="ir.rule">
        <field name="name">Minutas - editar borradores relacionados</field>
        <field name="model_id" ref="model_aq_meeting_minute"/>
        <field name="domain_force">['&amp;', ('state', '=', 'draft'), '|', '|', ('capture_by_id', '=', user.id), ('booking_id.requested_by_id', '=', user.id), ('participant_partner_ids', 'in', [user.partner_id.id])]</field>
        <field name="groups" eval="[(4, ref('group_meeting_room_applicant'))]"/>
        <field name="perm_read" eval="False"/>
        <field name="perm_write" eval="True"/>
        <field name="perm_create" eval="False"/>
        <field name="perm_unlink" eval="False"/>
    </record>

    <record id="rule_minute_approver_all" model="ir.rule">
        <field name="name">Minutas - autorizadores</field>
        <field name="model_id" ref="model_aq_meeting_minute"/>
        <field name="domain_force">[(1, '=', 1)]</field>
        <field name="groups" eval="[(4, ref('group_meeting_room_approver'))]"/>
        <field name="perm_read" eval="True"/>
        <field name="perm_write" eval="True"/>
        <field name="perm_create" eval="True"/>
        <field name="perm_unlink" eval="False"/>
    </record>

    <record id="rule_minute_manager_all" model="ir.rule">
        <field name="name">Minutas - administrador general</field>
        <field name="model_id" ref="model_aq_meeting_minute"/>
        <field name="domain_force">[(1, '=', 1)]</field>
        <field name="groups" eval="[(4, ref('group_meeting_room_manager'))]"/>
        <field name="perm_read" eval="True"/>
        <field name="perm_write" eval="True"/>
        <field name="perm_create" eval="True"/>
        <field name="perm_unlink" eval="True"/>
    </record>

    <record id="rule_minute_line_related" model="ir.rule">
        <field name="name">Líneas de minuta - relacionadas</field>
        <field name="model_id" ref="model_aq_meeting_minute_line"/>
        <field name="domain_force">['|', '|', ('minute_id.capture_by_id', '=', user.id), ('minute_id.booking_id.requested_by_id', '=', user.id), ('minute_id.participant_partner_ids', 'in', [user.partner_id.id])]</field>
        <field name="groups" eval="[(4, ref('group_meeting_room_applicant'))]"/>
        <field name="perm_read" eval="True"/>
        <field name="perm_write" eval="True"/>
        <field name="perm_create" eval="True"/>
        <field name="perm_unlink" eval="True"/>
    </record>

    <record id="rule_minute_line_approver_all" model="ir.rule">
        <field name="name">Líneas de minuta - autorizadores</field>
        <field name="model_id" ref="model_aq_meeting_minute_line"/>
        <field name="domain_force">[(1, '=', 1)]</field>
        <field name="groups" eval="[(4, ref('group_meeting_room_approver'))]"/>
        <field name="perm_read" eval="True"/>
        <field name="perm_write" eval="True"/>
        <field name="perm_create" eval="True"/>
        <field name="perm_unlink" eval="True"/>
    </record>
</odoo>
```

## ./static/src/js/dashboard.js
```js
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
```

## ./static/src/scss/dashboard.scss
```scss
// =============================================================
// Alphaqueb Meeting Rooms — Dashboard Odoo 18
// Tablero multi-sala: filas = salas, columnas = horas.
// Semántica de color: verde = libre/confirmada · ámbar = pendiente ·
// naranja = ocupación · gris = finalizada
// =============================================================

.o_aq_rooms {
    --aqr-bg: #f5f6f8;
    --aqr-card: #ffffff;
    --aqr-border: #e4e7ec;
    --aqr-border-strong: #cfd4dc;
    --aqr-text: #101828;
    --aqr-text-2: #475467;
    --aqr-text-3: #98a2b3;

    --aqr-primary: #4f46e5;
    --aqr-primary-hover: #4338ca;
    --aqr-primary-soft: #eef2ff;
    --aqr-primary-border: #c7d2fe;

    --aqr-green: #059669;
    --aqr-green-soft: #ecfdf5;
    --aqr-green-border: #a7f3d0;
    --aqr-green-text: #047857;

    --aqr-orange: #ea580c;
    --aqr-orange-soft: #fff7ed;
    --aqr-orange-border: #fed7aa;

    --aqr-red: #dc2626;
    --aqr-red-soft: #fef2f2;
    --aqr-red-border: #fecaca;
    --aqr-red-text: #b91c1c;

    --aqr-amber: #d97706;
    --aqr-amber-soft: #fffbeb;
    --aqr-amber-border: #fde68a;
    --aqr-amber-text: #b45309;

    --aqr-radius: 10px;
    --aqr-radius-lg: 14px;
    --aqr-shadow: 0 1px 2px rgba(16, 24, 40, 0.05);
    --aqr-shadow-md: 0 6px 16px rgba(16, 24, 40, 0.10);

    --aqr-label-w: 190px;
    --aqr-row-h: 52px;

    width: 100%;
    height: 100%;
    min-height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 20px 24px;
    background: var(--aqr-bg);
    color: var(--aqr-text);
    font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    line-height: 1.4;

    *,
    *::before,
    *::after {
        box-sizing: border-box;
    }

    h1,
    h2,
    p,
    ul {
        margin: 0;
    }

    ul {
        padding: 0;
        list-style: none;
    }

    button,
    input,
    select,
    textarea {
        font: inherit;
        color: inherit;
    }

    button {
        cursor: pointer;
    }

    button:disabled {
        cursor: not-allowed;
    }

    .aqr {
        max-width: 1480px;
        min-width: 0;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 16px;
    }

    // -----------------------------------------------------------------
    // Barra superior
    // -----------------------------------------------------------------

    .aqr__topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
    }

    .aqr__brand {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
    }

    .aqr__logo {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        flex: 0 0 auto;
        border-radius: var(--aqr-radius);
        background: var(--aqr-primary);
        color: #ffffff;
        box-shadow: var(--aqr-shadow);
    }

    .aqr__title {
        font-size: 19px;
        font-weight: 700;
        letter-spacing: -0.02em;
        line-height: 1.2;
    }

    .aqr__subtitle {
        margin-top: 2px;
        color: var(--aqr-text-2);
        font-size: 12.5px;
    }

    .aqr__controls {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
    }

    .datenav {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 4px;
        border: 1px solid var(--aqr-border);
        border-radius: var(--aqr-radius);
        background: var(--aqr-card);
        box-shadow: var(--aqr-shadow);
    }

    .datenav__arrow {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: var(--aqr-text-2);
        transition: background 0.15s ease, color 0.15s ease;

        &:hover {
            background: var(--aqr-bg);
            color: var(--aqr-text);
        }
    }

    .datenav__today {
        min-height: 30px;
        padding: 0 11px;
        border: 0;
        border-radius: 7px;
        background: transparent;
        color: var(--aqr-text-2);
        font-size: 12px;
        font-weight: 600;
        transition: background 0.15s ease, color 0.15s ease;

        &:hover {
            background: var(--aqr-bg);
            color: var(--aqr-text);
        }

        &.is-active {
            background: var(--aqr-primary-soft);
            color: var(--aqr-primary);
        }
    }

    .datenav__field {
        position: relative;
        display: inline-flex;
        align-items: center;
        min-width: 120px;
        min-height: 30px;
        margin: 0;
        padding: 0 10px;
        border-radius: 7px;
        cursor: pointer;
        transition: background 0.15s ease;

        &:hover {
            background: var(--aqr-bg);
        }
    }

    .datenav__label {
        font-size: 12.5px;
        font-weight: 600;
        white-space: nowrap;
        text-transform: capitalize;
        pointer-events: none;
    }

    .datenav__input {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        opacity: 0;
        cursor: pointer;
        border: 0;
    }

    // -----------------------------------------------------------------
    // Botones
    // -----------------------------------------------------------------

    .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        min-height: 38px;
        padding: 8px 14px;
        border: 1px solid transparent;
        border-radius: var(--aqr-radius);
        font-size: 13px;
        font-weight: 600;
        text-decoration: none;
        white-space: nowrap;
        transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, color 0.15s ease;
    }

    .btn--primary {
        background: var(--aqr-primary);
        color: #ffffff;
        box-shadow: var(--aqr-shadow);

        &:hover:not(:disabled) {
            background: var(--aqr-primary-hover);
        }

        &:disabled {
            background: var(--aqr-border);
            color: var(--aqr-text-3);
            box-shadow: none;
        }
    }

    .btn--secondary {
        border-color: var(--aqr-border);
        background: var(--aqr-card);
        color: var(--aqr-text-2);
        box-shadow: var(--aqr-shadow);

        &:hover:not(:disabled) {
            border-color: var(--aqr-border-strong);
            color: var(--aqr-text);
        }

        &:disabled {
            opacity: 0.5;
        }
    }

    .btn--approve {
        background: var(--aqr-green);
        color: #ffffff;

        &:hover:not(:disabled) {
            background: var(--aqr-green-text);
        }
    }

    .btn--danger {
        border-color: var(--aqr-red-border);
        background: var(--aqr-card);
        color: var(--aqr-red-text);

        &:hover:not(:disabled) {
            background: var(--aqr-red-soft);
        }
    }

    .btn--link {
        min-height: 0;
        padding: 2px 4px;
        border: 0;
        background: transparent;
        color: var(--aqr-primary);
        font-size: 12px;

        &:hover:not(:disabled) {
            text-decoration: underline;
        }
    }

    .btn--sm {
        min-height: 30px;
        padding: 5px 10px;
        border-radius: 8px;
        font-size: 12px;
    }

    .btn--block {
        width: 100%;
    }

    // -----------------------------------------------------------------
    // Estado vacío global (sin salas)
    // -----------------------------------------------------------------

    .hero-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        padding: 64px 24px;
        border: 1px dashed var(--aqr-border-strong);
        border-radius: var(--aqr-radius-lg);
        background: var(--aqr-card);
        text-align: center;
    }

    .hero-empty__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 56px;
        height: 56px;
        margin-bottom: 8px;
        border-radius: 16px;
        background: var(--aqr-primary-soft);
        color: var(--aqr-primary);
    }

    .hero-empty__title {
        font-size: 18px;
        font-weight: 700;
        letter-spacing: -0.01em;
    }

    .hero-empty__text {
        max-width: 420px;
        margin-bottom: 14px;
        color: var(--aqr-text-2);
        font-size: 13px;
    }

    // -----------------------------------------------------------------
    // Indicadores
    // -----------------------------------------------------------------

    .stats {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
    }

    .stat {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 16px;
        border: 1px solid var(--aqr-border);
        border-radius: var(--aqr-radius-lg);
        background: var(--aqr-card);
        box-shadow: var(--aqr-shadow);
        text-align: left;
    }

    // KPI accionable: lleva a la cola de solicitudes
    .stat--action {
        transition: border-color 0.15s ease, box-shadow 0.15s ease;

        &:hover {
            border-color: var(--aqr-border-strong);
            box-shadow: var(--aqr-shadow-md);

            .stat__chevron {
                transform: translateX(2px);
            }
        }

        &.is-alert {
            border-color: var(--aqr-amber-border);
            background: var(--aqr-amber-soft);

            .stat__value {
                color: var(--aqr-amber-text);
            }
        }
    }

    .stat__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 38px;
        height: 38px;
        flex: 0 0 auto;
        border-radius: var(--aqr-radius);

        &--total {
            background: var(--aqr-primary-soft);
            color: var(--aqr-primary);
        }

        &--free {
            background: var(--aqr-green-soft);
            color: var(--aqr-green);
        }

        &--busy {
            background: var(--aqr-orange-soft);
            color: var(--aqr-orange);
        }

        &--pending {
            background: var(--aqr-amber-soft);
            color: var(--aqr-amber);
        }
    }

    .stat__data {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1 1 auto;
    }

    .stat__value {
        font-size: 22px;
        font-weight: 700;
        line-height: 1.1;
        letter-spacing: -0.02em;
    }

    .stat__label {
        color: var(--aqr-text-2);
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .stat__chevron {
        flex: 0 0 auto;
        color: var(--aqr-text-3);
        transition: transform 0.15s ease;
    }

    // -----------------------------------------------------------------
    // Layout principal
    // -----------------------------------------------------------------

    .aqr__grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 340px;
        gap: 14px;
        align-items: start;
    }

    .aqr__side {
        display: flex;
        flex-direction: column;
        gap: 14px;
    }

    @media (min-width: 1280px) {
        .aqr__side {
            position: sticky;
            top: 12px;
        }
    }

    .panel {
        padding: 16px;
        border: 1px solid var(--aqr-border);
        border-radius: var(--aqr-radius-lg);
        background: var(--aqr-card);
        box-shadow: var(--aqr-shadow);
    }

    .panel__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 12px;
    }

    .panel__title {
        font-size: 15px;
        font-weight: 700;
        letter-spacing: -0.01em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .panel__count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 24px;
        height: 24px;
        padding: 0 7px;
        border-radius: 999px;
        background: var(--aqr-bg);
        color: var(--aqr-text-2);
        font-size: 12px;
        font-weight: 700;

        &.is-alert {
            background: var(--aqr-amber-soft);
            color: var(--aqr-amber-text);
        }
    }

    // -----------------------------------------------------------------
    // Tablero de disponibilidad (filas = salas, columnas = horas)
    // -----------------------------------------------------------------

    .board__heading {
        display: flex;
        align-items: baseline;
        gap: 10px;
        min-width: 0;
        flex-wrap: wrap;
    }

    .board__hint {
        color: var(--aqr-text-2);
        font-size: 12px;
    }

    .board__scroll {
        overflow-x: auto;
    }

    .board__inner {
        min-width: 760px;
    }

    .board__head {
        display: grid;
        grid-template-columns: var(--aqr-label-w) minmax(0, 1fr);
        margin-bottom: 4px;
    }

    .board__corner {
        padding: 0 10px 4px 2px;
        color: var(--aqr-text-3);
        font-size: 11px;
        font-weight: 650;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .board__hours {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
    }

    .board__hour {
        padding-bottom: 4px;
        color: var(--aqr-text-3);
        font-size: 10.5px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
    }

    .board__body {
        position: relative;
        border-top: 1px solid var(--aqr-border);
    }

    .board__now {
        position: absolute;
        top: 0;
        bottom: 0;
        z-index: 5;
        width: 0;
        border-left: 2px solid var(--aqr-red);
        pointer-events: none;

        &::before {
            content: "";
            position: absolute;
            top: -3px;
            left: -5px;
            width: 8px;
            height: 8px;
            border-radius: 999px;
            background: var(--aqr-red);
        }
    }

    .board__row {
        display: grid;
        grid-template-columns: var(--aqr-label-w) minmax(0, 1fr);
        min-height: var(--aqr-row-h);
        border-bottom: 1px solid var(--aqr-border);

        &.is-selected {
            background: var(--aqr-primary-soft);

            .board__room {
                box-shadow: inset 3px 0 0 var(--aqr-primary);
            }

            .board__room-name {
                color: var(--aqr-primary);
            }
        }
    }

    .board__room {
        display: flex;
        align-items: center;
        gap: 9px;
        min-width: 0;
        padding: 6px 10px 6px 8px;
        border: 0;
        border-right: 1px solid var(--aqr-border);
        background: transparent;
        text-align: left;
        transition: background 0.15s ease;

        &:hover {
            background: var(--aqr-bg);
        }
    }

    .room__dot {
        width: 9px;
        height: 9px;
        flex: 0 0 auto;
        border-radius: 999px;
        background: var(--aqr-text-3);

        &.is-available {
            background: var(--aqr-green);
        }

        &.is-occupied {
            background: var(--aqr-orange);
        }

        &.is-pending {
            background: var(--aqr-amber);
        }
    }

    .board__room-info {
        min-width: 0;
    }

    .board__room-name {
        display: block;
        overflow: hidden;
        font-size: 12.5px;
        font-weight: 650;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .board__room-meta {
        display: block;
        margin-top: 1px;
        overflow: hidden;
        color: var(--aqr-text-2);
        font-size: 11px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .board__track {
        position: relative;
        display: grid;
        grid-template-columns: repeat(24, minmax(0, 1fr));
    }

    .board__slot {
        min-height: var(--aqr-row-h);
        border: 0;
        border-left: 1px solid transparent;
        background: transparent;
        padding: 0;
        transition: background 0.12s ease;

        // línea guía en cada hora exacta
        &:nth-child(odd) {
            border-left-color: var(--aqr-border);
        }

        &:hover {
            background: var(--aqr-primary-soft);
            box-shadow: inset 0 0 0 1px var(--aqr-primary-border);
        }
    }

    .event {
        position: absolute;
        top: 7px;
        bottom: 7px;
        z-index: 3;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 0;
        padding: 3px 8px;
        overflow: hidden;
        border: 1px solid var(--aqr-green-border);
        border-left: 3px solid var(--aqr-green);
        border-radius: 7px;
        background: var(--aqr-green-soft);
        box-shadow: var(--aqr-shadow);
        cursor: pointer;
        transition: box-shadow 0.12s ease;

        &:hover {
            box-shadow: var(--aqr-shadow-md);
        }

        &.is-pending {
            border-color: var(--aqr-amber-border);
            border-left-color: var(--aqr-amber);
            background: var(--aqr-amber-soft);
        }

        &.is-done,
        &.is-muted {
            border-color: var(--aqr-border);
            border-left-color: var(--aqr-text-3);
            background: var(--aqr-bg);
        }
    }

    .event__title {
        overflow: hidden;
        font-size: 11.5px;
        font-weight: 700;
        line-height: 1.25;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .event__time {
        overflow: hidden;
        color: var(--aqr-text-2);
        font-size: 10px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .board__legend {
        display: flex;
        align-items: center;
        gap: 14px;
        flex-wrap: wrap;
        margin-top: 10px;
        color: var(--aqr-text-2);
        font-size: 11.5px;
    }

    .legend {
        display: inline-flex;
        align-items: center;
        gap: 6px;
    }

    .legend__swatch {
        width: 10px;
        height: 10px;
        border-radius: 3px;

        &--approved {
            background: var(--aqr-green);
        }

        &--pending {
            background: var(--aqr-amber);
        }

        &--muted {
            background: var(--aqr-text-3);
        }
    }

    // -----------------------------------------------------------------
    // Pills de estado
    // -----------------------------------------------------------------

    .pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 22px;
        padding: 3px 9px;
        border: 1px solid var(--aqr-border);
        border-radius: 999px;
        background: var(--aqr-bg);
        color: var(--aqr-text-2);
        font-size: 11px;
        font-weight: 650;
        line-height: 1;
        white-space: nowrap;
    }

    .pill--available {
        border-color: var(--aqr-green-border);
        background: var(--aqr-green-soft);
        color: var(--aqr-green-text);
    }

    .pill--occupied {
        border-color: var(--aqr-orange-border);
        background: var(--aqr-orange-soft);
        color: var(--aqr-orange);
    }

    .pill--pending {
        border-color: var(--aqr-amber-border);
        background: var(--aqr-amber-soft);
        color: var(--aqr-amber-text);
    }

    .pill--ink {
        border-color: var(--aqr-primary-border);
        background: var(--aqr-primary-soft);
        color: var(--aqr-primary);
    }

    .pill--muted {
        background: var(--aqr-bg);
        color: var(--aqr-text-3);
    }

    // -----------------------------------------------------------------
    // Formulario de reserva
    // -----------------------------------------------------------------

    .form__date {
        display: block;
        margin-top: 2px;
        color: var(--aqr-text-2);
        font-size: 12px;
        text-transform: capitalize;
    }

    .form__body {
        display: grid;
        gap: 12px;
    }

    .field {
        display: grid;
        gap: 5px;
        min-width: 0;
        margin: 0;
    }

    .field-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
    }

    .field__label {
        color: var(--aqr-text-2);
        font-size: 12px;
        font-weight: 600;
    }

    .field__required {
        color: var(--aqr-red);
        font-style: normal;
    }

    .field__optional {
        color: var(--aqr-text-3);
        font-weight: 500;
    }

    .input {
        width: 100%;
        min-width: 0;
        border: 1px solid var(--aqr-border);
        border-radius: var(--aqr-radius);
        outline: none;
        padding: 9px 11px;
        background: var(--aqr-card);
        color: var(--aqr-text);
        font-size: 13px;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;

        &:focus {
            border-color: var(--aqr-primary);
            box-shadow: 0 0 0 3px var(--aqr-primary-soft);
        }

        &::placeholder {
            color: var(--aqr-text-3);
        }
    }

    .input--textarea {
        min-height: 78px;
        resize: vertical;
    }

    .participants {
        position: relative;

        &__chips {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            margin-bottom: 6px;
        }

        &__search {
            position: relative;
        }

        &__menu {
            position: absolute;
            z-index: 20;
            top: calc(100% + 4px);
            left: 0;
            right: 0;
            margin: 0;
            padding: 4px;
            list-style: none;
            background: var(--aqr-card);
            border: 1px solid var(--aqr-border);
            border-radius: var(--aqr-radius);
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
            max-height: 220px;
            overflow-y: auto;
        }

        &__option {
            display: block;
            width: 100%;
            text-align: left;
            border: none;
            background: transparent;
            color: var(--aqr-text);
            padding: 7px 9px;
            border-radius: calc(var(--aqr-radius) - 2px);
            font-size: 13px;
            cursor: pointer;

            &:hover {
                background: var(--aqr-primary-soft);
                color: var(--aqr-primary);
            }
        }

        &__hint {
            display: block;
            margin-top: 5px;
            font-size: 11px;
            color: var(--aqr-text-3);
        }
    }

    .chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 4px 3px 10px;
        background: var(--aqr-primary-soft);
        color: var(--aqr-primary);
        border-radius: 999px;
        font-size: 12px;
        font-weight: 500;

        &__remove {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 18px;
            height: 18px;
            border: none;
            border-radius: 999px;
            background: transparent;
            color: inherit;
            font-size: 15px;
            line-height: 1;
            cursor: pointer;

            &:hover {
                background: rgba(0, 0, 0, 0.08);
            }
        }
    }

    .form__end {
        display: flex;
        align-items: center;
        min-height: 38px;
        padding: 9px 11px;
        border: 1px dashed var(--aqr-border);
        border-radius: var(--aqr-radius);
        background: var(--aqr-bg);
        color: var(--aqr-text);
        font-size: 13px;
        font-weight: 650;
        font-variant-numeric: tabular-nums;
    }

    .durations {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
    }

    .durations__label {
        color: var(--aqr-text-2);
        font-size: 12px;
        font-weight: 600;
    }

    .durations__btn {
        min-height: 26px;
        padding: 3px 10px;
        border: 1px solid var(--aqr-border);
        border-radius: 999px;
        background: var(--aqr-card);
        color: var(--aqr-text-2);
        font-size: 11.5px;
        font-weight: 600;
        transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;

        &:hover {
            border-color: var(--aqr-primary);
            color: var(--aqr-primary);
        }

        &.is-active {
            border-color: var(--aqr-primary);
            background: var(--aqr-primary-soft);
            color: var(--aqr-primary);
        }
    }

    .alert {
        margin: 0;
        padding: 10px 12px;
        border-radius: var(--aqr-radius);
        font-size: 12px;
        line-height: 1.4;
    }

    .alert--warn {
        border: 1px solid var(--aqr-amber-border);
        background: var(--aqr-amber-soft);
        color: var(--aqr-amber-text);

        strong {
            display: block;
            margin-bottom: 4px;
        }

        ul {
            display: grid;
            gap: 2px;
            padding-left: 16px;
            list-style: disc;
        }
    }

    // -----------------------------------------------------------------
    // Solicitudes pendientes
    // -----------------------------------------------------------------

    .pending__body {
        display: grid;
        gap: 10px;
    }

    .ticket {
        display: grid;
        gap: 10px;
        padding: 12px;
        border: 1px solid var(--aqr-border);
        border-radius: var(--aqr-radius);
        background: var(--aqr-card);
    }

    .ticket__head,
    .ticket__foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
    }

    .ticket__info {
        min-width: 0;
    }

    .ticket__title {
        display: block;
        overflow: hidden;
        font-size: 12.5px;
        font-weight: 700;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .ticket__meta {
        display: block;
        margin-top: 2px;
        overflow: hidden;
        color: var(--aqr-text-2);
        font-size: 11.5px;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .ticket__owner {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
    }

    .avatar {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        flex: 0 0 auto;
        border-radius: 999px;
        background: var(--aqr-primary-soft);
        color: var(--aqr-primary);
        font-size: 9.5px;
        font-weight: 800;
    }

    .ticket__name {
        max-width: 130px;
        overflow: hidden;
        color: var(--aqr-text-2);
        font-size: 11.5px;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .ticket__actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
        flex-wrap: wrap;
    }

    // -----------------------------------------------------------------
    // Estados vacíos y carga
    // -----------------------------------------------------------------

    .empty {
        display: grid;
        gap: 3px;
        padding: 16px;
        border: 1px dashed var(--aqr-border-strong);
        border-radius: var(--aqr-radius);
        background: var(--aqr-bg);
        color: var(--aqr-text-2);
        font-size: 12px;

        strong {
            color: var(--aqr-text);
            font-size: 12.5px;
        }
    }

    .loading {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 18px;
        border: 1px solid var(--aqr-border);
        border-radius: var(--aqr-radius-lg);
        background: var(--aqr-card);
        color: var(--aqr-text-2);
        font-weight: 600;
    }

    .loading__spinner {
        width: 16px;
        height: 16px;
        flex: 0 0 auto;
        border: 2px solid var(--aqr-border);
        border-top-color: var(--aqr-primary);
        border-radius: 999px;
        animation: aqrSpin 0.8s linear infinite;
    }

    @keyframes aqrSpin {
        to {
            transform: rotate(360deg);
        }
    }

    .aqr__foot {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        padding: 0 2px 8px;
        color: var(--aqr-text-3);
        font-size: 11.5px;
    }

    // -----------------------------------------------------------------
    // Responsivo
    // -----------------------------------------------------------------

    @media (max-width: 1100px) {
        --aqr-label-w: 150px;

        .aqr__grid {
            grid-template-columns: 1fr;
        }

        .aqr__side {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            align-items: start;
        }
    }

    @media (max-width: 920px) {
        padding: 14px;

        .stats {
            grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .aqr__side {
            grid-template-columns: 1fr;
        }
    }

    @media (max-width: 640px) {
        padding: 10px;
        --aqr-label-w: 120px;

        .aqr__topbar {
            align-items: stretch;
            flex-direction: column;
        }

        .aqr__controls {
            justify-content: space-between;
        }

        .datenav {
            flex: 1 1 auto;
            justify-content: space-between;
        }

        .stats {
            grid-template-columns: 1fr;
        }

        .field-grid {
            grid-template-columns: 1fr;
        }

        .ticket__head,
        .ticket__foot {
            align-items: stretch;
            flex-direction: column;
        }

        .ticket__actions .btn {
            flex: 1 1 auto;
        }
    }
}
```

## ./static/src/scss/minute.scss
```scss
// =============================================================
// Alphaqueb Meeting Rooms — Formulario de minutas
// Espaciado y jerarquía visual para la captura de minutas.
// =============================================================

.aq-minute-form {

    // Título principal con más presencia
    .oe_title {
        margin-bottom: 16px;

        h1 {
            letter-spacing: -0.02em;
        }

        h3 {
            margin-bottom: 0;
        }
    }

    // Grupos de campos con respiración entre filas
    .o_group {
        margin-bottom: 12px;
    }

    .o_inner_group {
        row-gap: 4px;

        > .o_horizontal_separator {
            margin-bottom: 8px;
        }
    }

    .o_form_label {
        color: var(--o-form-label-color, #495057);
    }

    // Separadores como encabezados de sección claros
    .o_horizontal_separator {
        margin: 22px 0 10px;
        padding-bottom: 6px;
        border-bottom: 1px solid var(--border-color, #dee2e6);
        color: var(--o-main-text-color, #212529);
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.03em;
        text-transform: uppercase;
    }

    // Pestañas con más aire y contenido despegado
    .o_notebook {
        margin-top: 20px;

        .nav-tabs .nav-link {
            padding: 10px 18px;
            font-weight: 600;
        }

        .o_notebook_content {
            padding-top: 18px;

            > .o_horizontal_separator:first-child {
                margin-top: 0;
            }
        }
    }

    // Editores de texto enriquecido con altura mínima cómoda
    .o_field_html {
        margin-bottom: 12px;

        .odoo-editor-editable,
        .o_readonly {
            min-height: 110px;
            padding: 12px 14px;
            border: 1px solid var(--border-color, #dee2e6);
            border-radius: 8px;
        }

        .odoo-editor-editable:focus-within {
            border-color: var(--o-enterprise-primary-color, #714b67);
        }
    }

    // Listas editables: filas más altas y legibles
    .o_field_x2many {
        margin-bottom: 12px;

        .o_list_renderer {
            border: 1px solid var(--border-color, #dee2e6);
            border-radius: 8px;

            thead th {
                padding-top: 9px;
                padding-bottom: 9px;
                background: var(--o-view-background-color, #f8f9fa);
                font-weight: 650;
            }

            .o_data_row .o_data_cell {
                padding-top: 8px;
                padding-bottom: 8px;
            }
        }

        // Botón "Agregar línea" más visible
        .o_field_x2many_list_row_add {
            a {
                display: inline-block;
                padding: 9px 6px;
                font-weight: 650;
            }
        }
    }
}
```

## ./static/src/xml/dashboard.xml
```xml
<?xml version="1.0" encoding="UTF-8"?>
<templates xml:space="preserve">
    <t t-name="aq_meeting_rooms.Dashboard">
        <div class="o_aq_rooms">
            <div class="aqr">

                <!-- Barra superior -->
                <header class="aqr__topbar">
                    <div class="aqr__brand">
                        <span class="aqr__logo" aria-hidden="true">
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <rect x="3" y="3" width="7" height="7" rx="1.5"/>
                                <rect x="14" y="3" width="7" height="7" rx="1.5"/>
                                <rect x="14" y="14" width="7" height="7" rx="1.5"/>
                                <rect x="3" y="14" width="7" height="7" rx="1.5"/>
                            </svg>
                        </span>
                        <div class="aqr__brand-text">
                            <h1 class="aqr__title">Salas de juntas</h1>
                            <p class="aqr__subtitle">Encuentra un hueco libre y reserva con un clic.</p>
                        </div>
                    </div>

                    <div class="aqr__controls">
                        <div class="datenav">
                            <button class="datenav__arrow" type="button" data-day="-1" aria-label="Día anterior" t-on-click="changeDateBy">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                            </button>

                            <button type="button"
                                    t-att-class="'datenav__today ' + (isToday ? 'is-active' : '')"
                                    t-on-click="goToday">
                                Hoy
                            </button>

                            <label class="datenav__field">
                                <span class="datenav__label" t-esc="dateLong"/>
                                <input class="datenav__input" type="date" t-att-value="state.date" t-on-change="onDateChange" aria-label="Seleccionar fecha"/>
                            </label>

                            <button class="datenav__arrow" type="button" data-day="1" aria-label="Día siguiente" t-on-click="changeDateBy">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                            </button>
                        </div>

                        <button class="btn btn--secondary" type="button" t-on-click="refreshDashboard" title="Recargar la información">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="23 4 23 10 17 10"/>
                                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                            </svg>
                            Actualizar
                        </button>
                    </div>
                </header>

                <t t-if="state.loading">
                    <div class="loading">
                        <span class="loading__spinner" aria-hidden="true"/>
                        <span>Cargando disponibilidad…</span>
                    </div>
                </t>

                <!-- Sin salas: estado vacío global con CTA -->
                <t t-elif="!state.rooms.length">
                    <div class="hero-empty">
                        <span class="hero-empty__icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M3 21h18"/>
                                <path d="M5 21V7l7-4 7 4v14"/>
                                <path d="M9 21v-6h6v6"/>
                            </svg>
                        </span>
                        <h2 class="hero-empty__title">Aún no hay salas registradas</h2>
                        <p class="hero-empty__text">
                            Da de alta tu primera sala de juntas para empezar a recibir reservas
                            y gestionar autorizaciones desde este tablero.
                        </p>
                        <button class="btn btn--primary" type="button" t-on-click="openRoomConfig">
                            Dar de alta una sala
                        </button>
                    </div>
                </t>

                <t t-else="">
                    <!-- Indicadores -->
                    <section class="stats">
                        <article class="stat">
                            <span class="stat__icon stat__icon--total" aria-hidden="true">
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M3 21h18"/>
                                    <path d="M5 21V7l7-4 7 4v14"/>
                                    <path d="M9 21v-6h6v6"/>
                                </svg>
                            </span>
                            <div class="stat__data">
                                <span class="stat__value" t-esc="state.rooms.length"/>
                                <span class="stat__label">Salas registradas</span>
                            </div>
                        </article>

                        <article class="stat">
                            <span class="stat__icon stat__icon--free" aria-hidden="true">
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                                    <polyline points="22 4 12 14.01 9 11.01"/>
                                </svg>
                            </span>
                            <div class="stat__data">
                                <span class="stat__value" t-esc="freeRoomsCount"/>
                                <span class="stat__label">Disponibles hoy</span>
                            </div>
                        </article>

                        <article class="stat">
                            <span class="stat__icon stat__icon--busy" aria-hidden="true">
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <rect x="3" y="4" width="18" height="18" rx="2"/>
                                    <line x1="16" y1="2" x2="16" y2="6"/>
                                    <line x1="8" y1="2" x2="8" y2="6"/>
                                    <line x1="3" y1="10" x2="21" y2="10"/>
                                </svg>
                            </span>
                            <div class="stat__data">
                                <span class="stat__value" t-esc="occupiedRoomsCount"/>
                                <span class="stat__label">Con reservas</span>
                            </div>
                        </article>

                        <button type="button"
                                t-att-class="'stat stat--action ' + (state.pendingBookings.length ? 'is-alert' : '')"
                                t-on-click="scrollToPending"
                                title="Ir a la cola de solicitudes">
                            <span class="stat__icon stat__icon--pending" aria-hidden="true">
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <circle cx="12" cy="12" r="10"/>
                                    <polyline points="12 6 12 12 16 14"/>
                                </svg>
                            </span>
                            <div class="stat__data">
                                <span class="stat__value" t-esc="state.pendingBookings.length"/>
                                <span class="stat__label" t-if="state.canApprove">Por autorizar</span>
                                <span class="stat__label" t-else="">Mis pendientes</span>
                            </div>
                            <svg class="stat__chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <polyline points="9 18 15 12 9 6"/>
                            </svg>
                        </button>
                    </section>

                    <div class="aqr__grid">

                        <!-- Tablero de disponibilidad: filas = salas, columnas = horas -->
                        <section class="panel board">
                            <header class="panel__head">
                                <div class="board__heading">
                                    <h2 class="panel__title">Disponibilidad</h2>
                                    <span class="board__hint">Da clic en un horario libre para preparar la reserva.</span>
                                </div>

                                <button class="btn btn--secondary btn--sm" type="button" t-if="selectedRoom" t-on-click="openRoomCalendar">
                                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <rect x="3" y="4" width="18" height="18" rx="2"/>
                                        <line x1="16" y1="2" x2="16" y2="6"/>
                                        <line x1="8" y1="2" x2="8" y2="6"/>
                                        <line x1="3" y1="10" x2="21" y2="10"/>
                                    </svg>
                                    Calendario de <t t-esc="selectedRoom.name"/>
                                </button>
                            </header>

                            <div class="board__scroll">
                                <div class="board__inner">
                                    <div class="board__head" aria-hidden="true">
                                        <span class="board__corner">Sala</span>
                                        <div class="board__hours">
                                            <span class="board__hour" t-foreach="trackHours" t-as="hour" t-key="hour" t-esc="formatHour(hour)"/>
                                        </div>
                                    </div>

                                    <div class="board__body">
                                        <div class="board__now" t-if="nowLineStyle" t-att-style="nowLineStyle" aria-hidden="true"/>

                                        <div t-foreach="state.rooms"
                                             t-as="room"
                                             t-key="room.id"
                                             t-att-class="'board__row ' + (state.selectedRoomId === room.id ? 'is-selected' : '')">

                                            <button type="button"
                                                    class="board__room"
                                                    t-att-data-room-id="room.id"
                                                    t-att-title="roomStatusLabel(room)"
                                                    t-on-click="selectRoom">
                                                <span t-att-class="'room__dot ' + roomDotClass(room)" aria-hidden="true"/>
                                                <span class="board__room-info">
                                                    <span class="board__room-name" t-esc="room.name"/>
                                                    <span class="board__room-meta">
                                                        <t t-esc="room.capacity || 0"/>p
                                                        <t t-if="room.location"> · <t t-esc="room.location"/></t>
                                                    </span>
                                                </span>
                                            </button>

                                            <div class="board__track">
                                                <button t-foreach="trackSlots"
                                                        t-as="slot"
                                                        t-key="slot"
                                                        type="button"
                                                        class="board__slot"
                                                        t-att-data-room-id="room.id"
                                                        t-att-data-time="slot"
                                                        t-att-aria-label="'Reservar ' + room.name + ' a las ' + formatTimeOption(slot)"
                                                        t-att-title="'Reservar a las ' + formatTimeOption(slot)"
                                                        t-on-click="onSlotClick"/>

                                                <article t-foreach="roomTimelineBookings(room.id)"
                                                         t-as="booking"
                                                         t-key="booking.id"
                                                         t-att-data-booking-id="booking.id"
                                                         t-att-class="'event ' + bookingStateClass(booking.state)"
                                                         t-att-style="timelineEventStyle(booking)"
                                                         t-att-title="bookingTooltip(booking)"
                                                         t-on-click="openBooking">
                                                    <span class="event__title" t-esc="booking.objective"/>
                                                    <span class="event__time" t-esc="bookingRange(booking)"/>
                                                </article>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <footer class="board__legend" aria-hidden="true">
                                <span class="legend"><span class="legend__swatch legend__swatch--approved"/> Confirmada</span>
                                <span class="legend"><span class="legend__swatch legend__swatch--pending"/> Por autorizar</span>
                                <span class="legend"><span class="legend__swatch legend__swatch--muted"/> Finalizada</span>
                            </footer>
                        </section>

                        <!-- Columna lateral -->
                        <div class="aqr__side">

                            <section class="panel form" t-att-style="state.canApprove and state.pendingBookings.length ? 'order: 1;' : ''">
                                <header class="panel__head">
                                    <div>
                                        <h2 class="panel__title">Nueva reserva</h2>
                                        <span class="form__date" t-esc="dateLong"/>
                                    </div>
                                    <button type="button" class="btn btn--link btn--sm" t-on-click="openFullRequestForm">
                                        Más opciones
                                    </button>
                                </header>

                                <form class="form__body" t-on-submit.prevent="createQuickRequest">
                                    <label class="field">
                                        <span class="field__label">Sala</span>
                                        <select class="input" t-att-value="state.selectedRoomId || ''" t-on-change="onRoomSelect">
                                            <option value="">Selecciona una sala…</option>
                                            <option t-foreach="state.rooms"
                                                    t-as="room"
                                                    t-key="room.id"
                                                    t-att-value="room.id"
                                                    t-att-selected="state.selectedRoomId === room.id">
                                                <t t-esc="room.name"/>
                                            </option>
                                        </select>
                                    </label>

                                    <div class="field-grid">
                                        <label class="field">
                                            <span class="field__label">Hora de inicio</span>
                                            <select class="input" t-model="state.form.startTime">
                                                <option t-foreach="trackSlots" t-as="slot" t-key="slot" t-att-value="slot">
                                                    <t t-esc="formatTimeOption(slot)"/>
                                                </option>
                                            </select>
                                        </label>

                                        <div class="field">
                                            <span class="field__label">Termina</span>
                                            <span class="form__end" t-esc="formStopLabel"/>
                                        </div>
                                    </div>

                                    <div class="durations" role="group" aria-label="Duración">
                                        <span class="durations__label">Duración:</span>
                                        <button t-foreach="durationOptions"
                                                t-as="option"
                                                t-key="option.minutes"
                                                type="button"
                                                t-att-class="'durations__btn ' + (state.form.duration === option.minutes ? 'is-active' : '')"
                                                t-att-data-minutes="option.minutes"
                                                t-on-click="setDuration"
                                                t-esc="option.label"/>
                                    </div>

                                    <label class="field">
                                        <span class="field__label">Objetivo <em class="field__required">*</em></span>
                                        <input class="input js-aq-objective"
                                               type="text"
                                               t-model="state.form.objective"
                                               placeholder="Ej. Revisión semanal de proyecto"/>
                                    </label>

                                    <label class="field">
                                        <span class="field__label">Agenda <span class="field__optional">opcional</span></span>
                                        <textarea class="input input--textarea"
                                                  t-model="state.form.agenda"
                                                  rows="3"
                                                  placeholder="1. Avances&#10;2. Bloqueos&#10;3. Acuerdos"/>
                                    </label>

                                    <div class="field participants">
                                        <span class="field__label">Invitados <span class="field__optional">opcional</span></span>
                                        <div class="participants__chips" t-if="state.form.participants.length">
                                            <span class="chip" t-foreach="state.form.participants" t-as="participant" t-key="participant.id">
                                                <t t-esc="participant.name"/>
                                                <button class="chip__remove"
                                                        type="button"
                                                        t-att-data-user-id="participant.id"
                                                        t-on-click="removeParticipant"
                                                        title="Quitar invitado">×</button>
                                            </span>
                                        </div>
                                        <div class="participants__search">
                                            <input class="input"
                                                   type="text"
                                                   t-att-value="state.participantQuery"
                                                   t-on-input="onParticipantSearch"
                                                   placeholder="Busca y agrega usuarios internos…"/>
                                            <ul class="participants__menu" t-if="filteredParticipants.length">
                                                <li t-foreach="filteredParticipants" t-as="user" t-key="user.id">
                                                    <button class="participants__option"
                                                            type="button"
                                                            t-att-data-user-id="user.id"
                                                            t-on-click="addParticipant"
                                                            t-esc="user.name"/>
                                                </li>
                                            </ul>
                                        </div>
                                        <span class="participants__hint">El solicitante se agrega automáticamente.</span>
                                    </div>

                                    <div class="alert alert--warn" t-if="quickConflicts.length">
                                        <strong>El horario cruza con:</strong>
                                        <ul>
                                            <li t-foreach="quickConflicts" t-as="booking" t-key="booking.id">
                                                <t t-esc="bookingRange(booking)"/> · <t t-esc="booking.objective"/>
                                            </li>
                                        </ul>
                                    </div>

                                    <button class="btn btn--primary btn--block"
                                            type="submit"
                                            t-att-disabled="!state.selectedRoomId || !hasObjective || quickConflicts.length">
                                        <t t-if="!state.selectedRoomId">Selecciona una sala</t>
                                        <t t-elif="!hasObjective">Captura el objetivo</t>
                                        <t t-elif="quickConflicts.length">Horario ocupado</t>
                                        <t t-else="">Enviar solicitud</t>
                                    </button>
                                </form>
                            </section>

                            <section class="panel pending js-aq-pending"
                                     t-att-style="state.canApprove and state.pendingBookings.length ? 'order: 0;' : ''">
                                <header class="panel__head">
                                    <h2 class="panel__title" t-if="state.canApprove">Por autorizar</h2>
                                    <h2 class="panel__title" t-else="">Mis solicitudes</h2>
                                    <span t-att-class="'panel__count ' + (state.pendingBookings.length ? 'is-alert' : '')"
                                          t-esc="state.pendingBookings.length"/>
                                </header>

                                <div class="pending__body" t-if="state.pendingBookings.length">
                                    <article class="ticket"
                                             t-foreach="state.pendingBookings"
                                             t-as="booking"
                                             t-key="booking.id">
                                        <div class="ticket__head">
                                            <div class="ticket__info">
                                                <span class="ticket__title" t-esc="booking.objective"/>
                                                <span class="ticket__meta">
                                                    <t t-esc="booking.room_name"/> · <t t-esc="bookingRange(booking)"/>
                                                </span>
                                            </div>
                                            <span t-att-class="'pill ' + bookingPillClass(booking.state)" t-esc="booking.state_label"/>
                                        </div>

                                        <div class="ticket__foot">
                                            <span class="ticket__owner">
                                                <span class="avatar" t-esc="pendingInitials(booking)"/>
                                                <span class="ticket__name" t-esc="booking.requested_by"/>
                                            </span>

                                            <div class="ticket__actions">
                                                <button class="btn btn--secondary btn--sm"
                                                        type="button"
                                                        t-att-data-booking-id="booking.id"
                                                        t-on-click="openBooking">
                                                    Abrir
                                                </button>

                                                <button class="btn btn--approve btn--sm"
                                                        type="button"
                                                        t-if="state.canApprove"
                                                        t-att-data-booking-id="booking.id"
                                                        t-on-click="approveBooking">
                                                    Autorizar
                                                </button>

                                                <button class="btn btn--danger btn--sm"
                                                        type="button"
                                                        t-if="state.canApprove"
                                                        t-att-data-booking-id="booking.id"
                                                        t-on-click="rejectBooking">
                                                    Rechazar
                                                </button>
                                            </div>
                                        </div>
                                    </article>
                                </div>

                                <div class="empty" t-else="">
                                    <strong>Sin solicitudes pendientes</strong>
                                    <span>Cuando alguien envíe una reserva aparecerá aquí.</span>
                                </div>
                            </section>

                        </div>
                    </div>
                </t>

                <footer class="aqr__foot">
                    <span>aq_meeting_rooms · Actualizado <t t-esc="state.lastUpdatedText"/></span>
                    <span>Las solicitudes pasan por aprobación de Operaciones.</span>
                </footer>
            </div>
        </div>
    </t>
</templates>
```

## ./views/booking_views.xml
```xml
<?xml version="1.0" encoding="UTF-8"?>
<odoo>
    <record id="view_aq_meeting_room_booking_list" model="ir.ui.view">
        <field name="name">aq.meeting.room.booking.list</field>
        <field name="model">aq.meeting.room.booking</field>
        <field name="arch" type="xml">
            <list string="Reservas de salas" decoration-muted="state in ['cancelled', 'rejected']" decoration-success="state == 'approved'" decoration-warning="state == 'pending'">
                <field name="name"/>
                <field name="room_id"/>
                <field name="objective"/>
                <field name="requested_by_id"/>
                <field name="start"/>
                <field name="stop"/>
                <field name="duration"/>
                <field name="participant_partner_ids" widget="many2many_tags" optional="hide"/>
                <field name="state" widget="badge" decoration-info="state == 'draft'" decoration-warning="state == 'pending'" decoration-success="state == 'approved'" decoration-muted="state in ['cancelled', 'rejected', 'done']"/>
                <field name="approver_id" optional="hide"/>
            </list>
        </field>
    </record>

    <record id="view_aq_meeting_room_booking_calendar" model="ir.ui.view">
        <field name="name">aq.meeting.room.booking.calendar</field>
        <field name="model">aq.meeting.room.booking</field>
        <field name="arch" type="xml">
            <calendar string="Calendario de salas" date_start="start" date_stop="stop" color="room_id" mode="week" quick_create="false">
                <field name="name"/>
                <field name="room_id"/>
                <field name="objective"/>
                <field name="requested_by_id"/>
                <field name="state"/>
            </calendar>
        </field>
    </record>

    <record id="view_aq_meeting_room_booking_form" model="ir.ui.view">
        <field name="name">aq.meeting.room.booking.form</field>
        <field name="model">aq.meeting.room.booking</field>
        <field name="arch" type="xml">
            <form string="Reserva de sala">
                <header>
                    <button name="action_request" type="object" string="Enviar solicitud" class="btn-primary" invisible="state != 'draft'"/>
                    <button name="action_approve" type="object" string="Autorizar" class="btn-primary" groups="aq_meeting_rooms.group_meeting_room_approver" invisible="state != 'pending'"/>
                    <button name="action_reject" type="object" string="Rechazar" class="btn-secondary" groups="aq_meeting_rooms.group_meeting_room_approver" invisible="state != 'pending'"/>
                    <button name="action_cancel" type="object" string="Cancelar" class="btn-secondary" invisible="state in ['cancelled', 'done']"/>
                    <button name="action_open_minute" type="object" string="Abrir sesión / minuta" class="btn-primary" invisible="state not in ['approved', 'done']"/>
                    <button name="action_send_invitation" type="object" string="Reenviar invitación" class="btn-secondary" invisible="state not in ['approved', 'done']"/>
                    <button name="action_done" type="object" string="Finalizar reunión" class="btn-secondary" invisible="state != 'approved'"/>
                    <field name="state" widget="statusbar" statusbar_visible="draft,pending,approved,done"/>
                </header>
                <sheet>
                    <div class="oe_button_box" name="button_box">
                        <button name="action_view_minutes" type="object" class="oe_stat_button" icon="fa-file-text-o" invisible="minute_count == 0">
                            <field name="minute_count" widget="statinfo" string="Minutas"/>
                        </button>
                    </div>

                    <div class="oe_title">
                        <label for="name"/>
                        <h1><field name="name" readonly="1"/></h1>
                        <label for="objective"/>
                        <h2><field name="objective" placeholder="Ej. Revisión semanal de operaciones"/></h2>
                    </div>

                    <div class="alert alert-info" role="alert" invisible="state not in ['draft', 'pending']">
                        Antes de enviar o autorizar, valida sala, horario, objetivo y participantes. El sistema bloqueará solicitudes que crucen con reservas autorizadas o pendientes.
                    </div>

                    <group>
                        <group string="Sala y disponibilidad">
                            <field name="room_id" options="{'no_create_edit': True}"/>
                            <field name="start"/>
                            <field name="stop"/>
                            <field name="duration" readonly="1"/>
                        </group>
                        <group string="Flujo de autorización">
                            <field name="requested_by_id" readonly="state != 'draft'"/>
                            <field name="approver_id" readonly="1"/>
                            <field name="decision_date" readonly="1"/>
                            <field name="invitation_sent" readonly="1"/>
                            <field name="invitation_date" readonly="1" invisible="not invitation_sent"/>
                            <field name="company_id" groups="base.group_multi_company" readonly="1"/>
                        </group>
                    </group>

                    <notebook>
                        <page string="Participantes">
                            <group>
                                <field name="participant_partner_ids" widget="many2many_tags" placeholder="Selecciona participantes internos o contactos externos"/>
                            </group>
                        </page>

                        <page string="Agenda y contexto">
                            <group>
                                <field name="agenda" placeholder="Puntos a tratar, información previa y contexto."/>
                                <field name="notes" placeholder="Notas internas para el solicitante, autorizador o administrador."/>
                            </group>
                        </page>

                        <page string="Decisión y cierre">
                            <group>
                                <field name="rejection_reason" placeholder="Motivo si la solicitud fue rechazada." readonly="state not in ['pending', 'rejected']"/>
                                <field name="cancel_reason" placeholder="Motivo si la solicitud fue cancelada." readonly="state == 'done'"/>
                            </group>
                        </page>

                        <page string="Minutas">
                            <field name="minute_ids" context="{'default_booking_id': id}">
                                <list>
                                    <field name="name"/>
                                    <field name="capture_by_id"/>
                                    <field name="state"/>
                                    <field name="shared_date"/>
                                </list>
                            </field>
                        </page>
                    </notebook>
                </sheet>
                <chatter/>
            </form>
        </field>
    </record>

    <record id="view_aq_meeting_room_booking_search" model="ir.ui.view">
        <field name="name">aq.meeting.room.booking.search</field>
        <field name="model">aq.meeting.room.booking</field>
        <field name="arch" type="xml">
            <search string="Buscar reservas">
                <field name="name"/>
                <field name="objective"/>
                <field name="room_id"/>
                <field name="requested_by_id"/>
                <field name="participant_partner_ids"/>
                <filter name="pending" string="Pendientes" domain="[('state', '=', 'pending')]"/>
                <filter name="approved" string="Autorizadas" domain="[('state', '=', 'approved')]"/>
                <filter name="mine" string="Mis solicitudes" domain="[('requested_by_id', '=', uid)]"/>
                <filter name="today" string="Hoy" domain="[('start', '&gt;=', context_today().strftime('%Y-%m-%d 00:00:00')), ('start', '&lt;=', context_today().strftime('%Y-%m-%d 23:59:59'))]"/>
                <group expand="0" string="Agrupar por">
                    <filter name="group_room" string="Sala" context="{'group_by': 'room_id'}"/>
                    <filter name="group_state" string="Estado" context="{'group_by': 'state'}"/>
                    <filter name="group_requested_by" string="Solicitante" context="{'group_by': 'requested_by_id'}"/>
                    <filter name="group_start_day" string="Día" context="{'group_by': 'start:day'}"/>
                </group>
            </search>
        </field>
    </record>

    <record id="action_aq_meeting_room_booking" model="ir.actions.act_window">
        <field name="name">Solicitudes de salas</field>
        <field name="res_model">aq.meeting.room.booking</field>
        <field name="view_mode">calendar,list,form</field>
        <field name="search_view_id" ref="view_aq_meeting_room_booking_search"/>
        <field name="context">{'search_default_today': 1}</field>
    </record>

    <record id="action_aq_meeting_room_booking_pending" model="ir.actions.act_window">
        <field name="name">Solicitudes pendientes</field>
        <field name="res_model">aq.meeting.room.booking</field>
        <field name="view_mode">list,form,calendar</field>
        <field name="domain">[('state', '=', 'pending')]</field>
        <field name="search_view_id" ref="view_aq_meeting_room_booking_search"/>
        <field name="context">{'search_default_pending': 1}</field>
    </record>
</odoo>
```

## ./views/dashboard_action.xml
```xml
<?xml version="1.0" encoding="UTF-8"?>
<odoo>
    <record id="action_aq_meeting_rooms_dashboard" model="ir.actions.client">
        <field name="name">Dashboard de salas</field>
        <field name="tag">aq_meeting_rooms.dashboard</field>
    </record>
</odoo>
```

## ./views/menu_views.xml
```xml
<?xml version="1.0" encoding="UTF-8"?>
<odoo>
    <menuitem id="menu_aq_meeting_rooms_root"
              name="Salas de juntas"
              sequence="35"
              web_icon="aq_meeting_rooms,static/description/icon.png"
              groups="aq_meeting_rooms.group_meeting_room_applicant"/>

    <menuitem id="menu_aq_meeting_rooms_dashboard"
              name="Dashboard"
              parent="menu_aq_meeting_rooms_root"
              action="action_aq_meeting_rooms_dashboard"
              sequence="10"
              groups="aq_meeting_rooms.group_meeting_room_applicant"/>

    <menuitem id="menu_aq_meeting_room_booking"
              name="Solicitudes y calendario"
              parent="menu_aq_meeting_rooms_root"
              action="action_aq_meeting_room_booking"
              sequence="20"
              groups="aq_meeting_rooms.group_meeting_room_applicant"/>

    <menuitem id="menu_aq_meeting_room_booking_pending"
              name="Pendientes por autorizar"
              parent="menu_aq_meeting_rooms_root"
              action="action_aq_meeting_room_booking_pending"
              sequence="30"
              groups="aq_meeting_rooms.group_meeting_room_approver"/>

    <menuitem id="menu_aq_meeting_minute"
              name="Minutas"
              parent="menu_aq_meeting_rooms_root"
              action="action_aq_meeting_minute"
              sequence="40"
              groups="aq_meeting_rooms.group_meeting_room_applicant"/>

    <menuitem id="menu_aq_meeting_rooms_config_root"
              name="Configuración"
              parent="menu_aq_meeting_rooms_root"
              sequence="90"
              groups="aq_meeting_rooms.group_meeting_room_manager"/>

    <menuitem id="menu_aq_meeting_room_config"
              name="Catálogo de salas"
              parent="menu_aq_meeting_rooms_config_root"
              action="action_aq_meeting_room"
              sequence="10"
              groups="aq_meeting_rooms.group_meeting_room_manager"/>
</odoo>
```

## ./views/minute_views.xml
```xml
<?xml version="1.0" encoding="UTF-8"?>
<odoo>
    <record id="view_aq_meeting_minute_list" model="ir.ui.view">
        <field name="name">aq.meeting.minute.list</field>
        <field name="model">aq.meeting.minute</field>
        <field name="arch" type="xml">
            <list string="Minutas" decoration-info="state == 'draft'" decoration-success="state == 'shared'">
                <field name="name"/>
                <field name="objective"/>
                <field name="booking_id" optional="hide"/>
                <field name="room_id"/>
                <field name="meeting_start"/>
                <field name="capture_by_id" widget="many2one_avatar_user"/>
                <field name="participant_partner_ids" widget="many2many_tags" optional="hide"/>
                <field name="state" widget="badge" decoration-info="state == 'draft'" decoration-primary="state == 'confirmed'" decoration-success="state == 'shared'"/>
                <field name="shared_date" optional="hide"/>
            </list>
        </field>
    </record>

    <record id="view_aq_meeting_minute_line_list" model="ir.ui.view">
        <field name="name">aq.meeting.minute.line.list</field>
        <field name="model">aq.meeting.minute.line</field>
        <field name="arch" type="xml">
            <list string="Estructura de minuta" editable="bottom" decoration-bf="item_type == 'section'" decoration-info="item_type == 'task'" decoration-warning="task_state == 'blocked'">
                <field name="sequence" widget="handle"/>
                <field name="parent_id" domain="[('minute_id', '=', minute_id)]" optional="show"/>
                <field name="item_type"/>
                <field name="name"/>
                <field name="responsible_partner_id" widget="many2one_avatar" optional="show"/>
                <field name="due_date" optional="show"/>
                <field name="priority" widget="priority" optional="hide"/>
                <field name="task_state" optional="show"/>
                <field name="description" optional="hide"/>
            </list>
        </field>
    </record>

    <record id="view_aq_meeting_minute_line_form" model="ir.ui.view">
        <field name="name">aq.meeting.minute.line.form</field>
        <field name="model">aq.meeting.minute.line</field>
        <field name="arch" type="xml">
            <form string="Elemento de minuta" class="aq-minute-form">
                <sheet>
                    <div class="oe_title">
                        <h1><field name="name" placeholder="Título claro del punto, acuerdo, decisión o tarea"/></h1>
                    </div>
                    <group>
                        <group string="Clasificación">
                            <field name="minute_id" readonly="1"/>
                            <field name="parent_id" domain="[('minute_id', '=', minute_id)]"/>
                            <field name="item_type"/>
                        </group>
                        <group string="Seguimiento" invisible="item_type == 'section'">
                            <field name="responsible_partner_id" widget="many2one_avatar"/>
                            <field name="due_date"/>
                            <field name="priority" widget="priority"/>
                            <field name="task_state" invisible="item_type != 'task'"/>
                        </group>
                    </group>
                    <separator string="Detalle"/>
                    <field name="description" nolabel="1" placeholder="Detalle suficiente para entender el contexto, conclusión y seguimiento."/>
                </sheet>
            </form>
        </field>
    </record>

    <record id="view_aq_meeting_minute_form" model="ir.ui.view">
        <field name="name">aq.meeting.minute.form</field>
        <field name="model">aq.meeting.minute</field>
        <field name="arch" type="xml">
            <form string="Minuta corporativa" class="aq-minute-form">
                <header>
                    <field name="line_count" invisible="1"/>
                    <button name="action_confirm" type="object" string="Confirmar minuta" class="btn-primary" invisible="state != 'draft'"/>
                    <button name="action_share_by_email" type="object" string="Compartir con participantes" class="btn-primary" invisible="state == 'draft'"/>
                    <button name="action_seed_structure" type="object" string="Crear estructura base" class="btn-secondary" invisible="line_count != 0"/>
                    <button name="action_print_minute" type="object" string="Descargar PDF" class="btn-secondary"/>
                    <button name="action_reset_draft" type="object" string="Regresar a borrador" class="btn-secondary" invisible="state == 'draft'"/>
                    <field name="state" widget="statusbar" statusbar_visible="draft,confirmed,shared"/>
                </header>
                <sheet>
                    <widget name="web_ribbon" title="Compartida" bg_color="text-bg-success" invisible="state != 'shared'"/>
                    <widget name="web_ribbon" title="Confirmada" bg_color="text-bg-info" invisible="state != 'confirmed'"/>

                    <div class="oe_title">
                        <h1><field name="name" readonly="1"/></h1>
                        <h3 class="text-muted fw-normal mt-1">
                            <field name="objective" readonly="1" placeholder="Objetivo de la reunión"/>
                        </h3>
                    </div>

                    <group>
                        <group string="Reunión">
                            <field name="booking_id" options="{'no_create_edit': True}"/>
                            <field name="room_id" readonly="1"/>
                            <field name="meeting_start" readonly="1"/>
                            <field name="meeting_stop" readonly="1"/>
                        </group>
                        <group string="Personas">
                            <field name="capture_by_id" widget="many2one_avatar_user"/>
                            <field name="chair_partner_id" widget="many2one_avatar"/>
                            <field name="requested_by_id" readonly="1" widget="many2one_avatar_user"/>
                            <field name="participant_partner_ids" widget="many2many_tags_avatar" placeholder="Personas que participaron o deben recibir seguimiento"/>
                            <field name="shared_date" readonly="1" invisible="not shared_date"/>
                        </group>
                    </group>

                    <notebook>
                        <page string="Resumen" name="page_summary">
                            <separator string="Resumen ejecutivo"/>
                            <field name="summary" nolabel="1" placeholder="Qué se revisó, por qué era importante y cuál fue la conclusión general."/>

                            <separator string="Acuerdos generales"/>
                            <field name="agreements_summary" nolabel="1" placeholder="Acuerdos generales que aplican a toda la reunión."/>

                            <separator string="Riesgos y bloqueos"/>
                            <field name="risk_notes" nolabel="1" placeholder="Riesgos, bloqueos o temas pendientes de resolución."/>
                        </page>

                        <page string="Puntos tratados" name="page_notes">
                            <field name="note_line_ids" nolabel="1" context="{'default_minute_id': id, 'default_item_type': 'note'}">
                                <list editable="bottom" decoration-muted="item_type == 'section'">
                                    <field name="sequence" widget="handle"/>
                                    <field name="item_type" invisible="1"/>
                                    <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]" optional="hide"/>
                                    <field name="name" string="Punto tratado" placeholder="Tema o punto revisado…"/>
                                    <field name="responsible_partner_id" widget="many2one_avatar" optional="show"/>
                                    <field name="description" optional="hide"/>
                                </list>
                                <form string="Punto tratado" class="aq-minute-form">
                                    <sheet>
                                        <div class="oe_title">
                                            <h1><field name="name" placeholder="Tema o punto revisado"/></h1>
                                        </div>
                                        <group>
                                            <group string="Ubicación">
                                                <field name="item_type" readonly="1"/>
                                                <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]"/>
                                            </group>
                                            <group string="Referencia">
                                                <field name="responsible_partner_id" widget="many2one_avatar"/>
                                            </group>
                                        </group>
                                        <separator string="Detalle"/>
                                        <field name="description" nolabel="1" placeholder="Contexto, datos revisados y conclusión del punto."/>
                                    </sheet>
                                </form>
                            </field>
                        </page>

                        <page string="Acuerdos y decisiones" name="page_agreements">
                            <separator string="Acuerdos"/>
                            <field name="agreement_line_ids" nolabel="1" context="{'default_minute_id': id, 'default_item_type': 'agreement'}">
                                <list editable="bottom">
                                    <field name="sequence" widget="handle"/>
                                    <field name="item_type" invisible="1"/>
                                    <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]" optional="hide"/>
                                    <field name="name" string="Acuerdo" placeholder="Acuerdo claro y verificable…"/>
                                    <field name="responsible_partner_id" string="Responsable" widget="many2one_avatar" optional="show"/>
                                    <field name="due_date" string="Fecha compromiso" optional="show"/>
                                    <field name="priority" widget="priority" optional="show"/>
                                    <field name="description" optional="hide"/>
                                </list>
                                <form string="Acuerdo" class="aq-minute-form">
                                    <sheet>
                                        <div class="oe_title">
                                            <h1><field name="name" placeholder="Acuerdo claro y verificable"/></h1>
                                        </div>
                                        <group>
                                            <group string="Ubicación">
                                                <field name="item_type" readonly="1"/>
                                                <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]"/>
                                            </group>
                                            <group string="Seguimiento">
                                                <field name="responsible_partner_id" widget="many2one_avatar"/>
                                                <field name="due_date"/>
                                                <field name="priority" widget="priority"/>
                                            </group>
                                        </group>
                                        <separator string="Detalle"/>
                                        <field name="description" nolabel="1" placeholder="Detalle del acuerdo, alcance y condición de cumplimiento."/>
                                    </sheet>
                                </form>
                            </field>

                            <separator string="Decisiones"/>
                            <field name="decision_line_ids" nolabel="1" context="{'default_minute_id': id, 'default_item_type': 'decision'}">
                                <list editable="bottom">
                                    <field name="sequence" widget="handle"/>
                                    <field name="item_type" invisible="1"/>
                                    <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]" optional="hide"/>
                                    <field name="name" string="Decisión" placeholder="Decisión tomada…"/>
                                    <field name="responsible_partner_id" string="Responsable" widget="many2one_avatar" optional="show"/>
                                    <field name="priority" widget="priority" optional="show"/>
                                    <field name="description" optional="hide"/>
                                </list>
                                <form string="Decisión" class="aq-minute-form">
                                    <sheet>
                                        <div class="oe_title">
                                            <h1><field name="name" placeholder="Decisión tomada"/></h1>
                                        </div>
                                        <group>
                                            <group string="Ubicación">
                                                <field name="item_type" readonly="1"/>
                                                <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]"/>
                                            </group>
                                            <group string="Seguimiento">
                                                <field name="responsible_partner_id" widget="many2one_avatar"/>
                                                <field name="priority" widget="priority"/>
                                            </group>
                                        </group>
                                        <separator string="Detalle"/>
                                        <field name="description" nolabel="1" placeholder="Criterio, impacto y alcance de la decisión."/>
                                    </sheet>
                                </form>
                            </field>
                        </page>

                        <page string="Tareas" name="page_tasks">
                            <field name="task_line_ids" nolabel="1" context="{'default_minute_id': id, 'default_item_type': 'task', 'default_task_state': 'todo'}">
                                <list editable="bottom" decoration-success="task_state == 'done'" decoration-warning="task_state == 'blocked'" decoration-info="task_state == 'in_progress'">
                                    <field name="sequence" widget="handle"/>
                                    <field name="item_type" invisible="1"/>
                                    <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]" optional="hide"/>
                                    <field name="name" string="Tarea / acción" placeholder="Acción concreta a ejecutar…"/>
                                    <field name="responsible_partner_id" widget="many2one_avatar"/>
                                    <field name="due_date"/>
                                    <field name="priority" widget="priority"/>
                                    <field name="task_state"/>
                                    <field name="description" optional="hide"/>
                                </list>
                                <form string="Tarea de seguimiento" class="aq-minute-form">
                                    <sheet>
                                        <div class="oe_title">
                                            <h1><field name="name" placeholder="Acción concreta a ejecutar"/></h1>
                                        </div>
                                        <group>
                                            <group string="Ubicación">
                                                <field name="item_type" readonly="1"/>
                                                <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]"/>
                                            </group>
                                            <group string="Seguimiento">
                                                <field name="responsible_partner_id" widget="many2one_avatar"/>
                                                <field name="due_date"/>
                                                <field name="priority" widget="priority"/>
                                                <field name="task_state"/>
                                            </group>
                                        </group>
                                        <separator string="Detalle"/>
                                        <field name="description" nolabel="1" placeholder="Resultado esperado, evidencia de cierre y dependencias."/>
                                    </sheet>
                                </form>
                            </field>
                        </page>

                        <page string="Riesgos" name="page_risks">
                            <field name="risk_line_ids" nolabel="1" context="{'default_minute_id': id, 'default_item_type': 'risk'}">
                                <list editable="bottom" decoration-warning="priority in ['2', '3']">
                                    <field name="sequence" widget="handle"/>
                                    <field name="item_type" invisible="1"/>
                                    <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]" optional="hide"/>
                                    <field name="name" string="Riesgo / bloqueo" placeholder="Riesgo o bloqueo detectado…"/>
                                    <field name="responsible_partner_id" string="Responsable" widget="many2one_avatar" optional="show"/>
                                    <field name="priority" widget="priority"/>
                                    <field name="description" optional="hide"/>
                                </list>
                                <form string="Riesgo o bloqueo" class="aq-minute-form">
                                    <sheet>
                                        <div class="oe_title">
                                            <h1><field name="name" placeholder="Riesgo o bloqueo detectado"/></h1>
                                        </div>
                                        <group>
                                            <group string="Ubicación">
                                                <field name="item_type" readonly="1"/>
                                                <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]"/>
                                            </group>
                                            <group string="Seguimiento">
                                                <field name="responsible_partner_id" widget="many2one_avatar"/>
                                                <field name="priority" widget="priority"/>
                                            </group>
                                        </group>
                                        <separator string="Detalle"/>
                                        <field name="description" nolabel="1" placeholder="Impacto, mitigación y siguiente paso recomendado."/>
                                    </sheet>
                                </form>
                            </field>
                        </page>

                        <page string="Estructura completa" name="page_structure">
                            <separator string="Secciones"/>
                            <field name="section_line_ids" nolabel="1" context="{'default_minute_id': id, 'default_item_type': 'section'}">
                                <list editable="bottom" decoration-bf="1">
                                    <field name="sequence" widget="handle"/>
                                    <field name="item_type" invisible="1"/>
                                    <field name="name" string="Sección" placeholder="Nombre de la sección…"/>
                                    <field name="description" optional="hide"/>
                                </list>
                            </field>

                            <separator string="Todos los elementos"/>
                            <field name="line_ids" nolabel="1" context="{'default_minute_id': id}">
                                <list editable="bottom" decoration-bf="item_type == 'section'" decoration-info="item_type == 'task'" decoration-warning="task_state == 'blocked'">
                                    <field name="sequence" widget="handle"/>
                                    <field name="parent_id" domain="[('minute_id', '=', parent.id)]" optional="show"/>
                                    <field name="item_type"/>
                                    <field name="name"/>
                                    <field name="responsible_partner_id" widget="many2one_avatar" optional="show"/>
                                    <field name="due_date" optional="show"/>
                                    <field name="priority" widget="priority" optional="hide"/>
                                    <field name="task_state" optional="show"/>
                                    <field name="description" optional="hide"/>
                                </list>
                                <form class="aq-minute-form">
                                    <sheet>
                                        <div class="oe_title">
                                            <h1><field name="name" placeholder="Título del elemento"/></h1>
                                        </div>
                                        <group>
                                            <group string="Jerarquía">
                                                <field name="parent_id" domain="[('minute_id', '=', parent.id)]"/>
                                                <field name="item_type"/>
                                            </group>
                                            <group string="Seguimiento">
                                                <field name="responsible_partner_id" widget="many2one_avatar"/>
                                                <field name="due_date"/>
                                                <field name="priority" widget="priority"/>
                                                <field name="task_state" invisible="item_type != 'task'"/>
                                            </group>
                                        </group>
                                        <separator string="Detalle"/>
                                        <field name="description" nolabel="1"/>
                                    </sheet>
                                </form>
                            </field>
                        </page>
                    </notebook>
                </sheet>
                <chatter/>
            </form>
        </field>
    </record>

    <record id="view_aq_meeting_minute_search" model="ir.ui.view">
        <field name="name">aq.meeting.minute.search</field>
        <field name="model">aq.meeting.minute</field>
        <field name="arch" type="xml">
            <search string="Buscar minutas">
                <field name="name"/>
                <field name="objective"/>
                <field name="booking_id"/>
                <field name="room_id"/>
                <field name="capture_by_id"/>
                <field name="participant_partner_ids"/>
                <filter name="draft" string="Borradores" domain="[('state', '=', 'draft')]"/>
                <filter name="confirmed" string="Confirmadas" domain="[('state', '=', 'confirmed')]"/>
                <filter name="shared" string="Compartidas" domain="[('state', '=', 'shared')]"/>
                <group expand="0" string="Agrupar por">
                    <filter name="group_room" string="Sala" context="{'group_by': 'room_id'}"/>
                    <filter name="group_state" string="Estado" context="{'group_by': 'state'}"/>
                    <filter name="group_capture" string="Capturó" context="{'group_by': 'capture_by_id'}"/>
                    <filter name="group_start_day" string="Día" context="{'group_by': 'meeting_start:day'}"/>
                </group>
            </search>
        </field>
    </record>

    <record id="action_aq_meeting_minute" model="ir.actions.act_window">
        <field name="name">Minutas corporativas</field>
        <field name="res_model">aq.meeting.minute</field>
        <field name="view_mode">list,form</field>
        <field name="search_view_id" ref="view_aq_meeting_minute_search"/>
    </record>
</odoo>
```

## ./views/room_views.xml
```xml
<?xml version="1.0" encoding="UTF-8"?>
<odoo>
    <record id="view_aq_meeting_room_list" model="ir.ui.view">
        <field name="name">aq.meeting.room.list</field>
        <field name="model">aq.meeting.room</field>
        <field name="arch" type="xml">
            <list string="Salas de juntas" decoration-success="availability_state == 'free'" decoration-warning="availability_state == 'soon'" decoration-danger="availability_state == 'busy'">
                <field name="sequence" widget="handle"/>
                <field name="name"/>
                <field name="code"/>
                <field name="capacity"/>
                <field name="location"/>
                <field name="responsible_id"/>
                <field name="availability_state"/>
                <field name="today_booking_count"/>
                <field name="pending_booking_count"/>
                <field name="active" optional="hide"/>
            </list>
        </field>
    </record>

    <record id="view_aq_meeting_room_kanban" model="ir.ui.view">
        <field name="name">aq.meeting.room.kanban</field>
        <field name="model">aq.meeting.room</field>
        <field name="arch" type="xml">
            <kanban class="o_kanban_mobile">
                <field name="name"/>
                <field name="code"/>
                <field name="capacity"/>
                <field name="location"/>
                <field name="availability_state"/>
                <field name="today_booking_count"/>
                <field name="image_1920"/>
                <templates>
                    <t t-name="card">
                        <div class="o_kanban_record_has_image_fill o_kanban_card">
                            <div class="o_kanban_image_fill_left" t-if="record.image_1920.raw_value">
                                <field name="image_1920" widget="image" class="o_kanban_image"/>
                            </div>
                            <div class="oe_kanban_details">
                                <strong class="o_kanban_record_title"><field name="name"/></strong>
                                <div class="text-muted" t-if="record.location.raw_value"><field name="location"/></div>
                                <div class="mt-2 d-flex gap-2 flex-wrap">
                                    <span class="badge rounded-pill text-bg-light">Capacidad: <field name="capacity"/></span>
                                    <span class="badge rounded-pill text-bg-light">Hoy: <field name="today_booking_count"/></span>
                                </div>
                                <div class="mt-2">
                                    <field name="availability_state" widget="badge" decoration-success="availability_state == 'free'" decoration-warning="availability_state == 'soon'" decoration-danger="availability_state == 'busy'"/>
                                </div>
                            </div>
                        </div>
                    </t>
                </templates>
            </kanban>
        </field>
    </record>

    <record id="view_aq_meeting_room_form" model="ir.ui.view">
        <field name="name">aq.meeting.room.form</field>
        <field name="model">aq.meeting.room</field>
        <field name="arch" type="xml">
            <form string="Sala de juntas">
                <header>
                    <button name="action_open_bookings" type="object" string="Ver reservas" class="btn-primary"/>
                </header>
                <sheet>
                    <div class="oe_button_box" name="button_box">
                        <button name="action_open_bookings" type="object" class="oe_stat_button" icon="fa-calendar">
                            <field name="today_booking_count" widget="statinfo" string="Reservas hoy"/>
                        </button>
                    </div>
                    <field name="image_1920" widget="image" class="oe_avatar"/>
                    <div class="oe_title">
                        <label for="name"/>
                        <h1><field name="name" placeholder="Sala de juntas principal"/></h1>
                    </div>
                    <group>
                        <group string="Identificación">
                            <field name="code"/>
                            <field name="sequence"/>
                            <field name="active"/>
                            <field name="company_id" groups="base.group_multi_company"/>
                        </group>
                        <group string="Operación">
                            <field name="capacity"/>
                            <field name="location"/>
                            <field name="responsible_id"/>
                            <field name="availability_state" readonly="1"/>
                        </group>
                    </group>
                    <notebook>
                        <page string="Descripción y equipo">
                            <group>
                                <field name="equipment" placeholder="Pantalla, cámara, micrófono, pizarrón, capacidad híbrida..."/>
                                <field name="description" placeholder="Describe el uso recomendado y políticas particulares de la sala."/>
                            </group>
                        </page>
                        <page string="Reservas">
                            <field name="booking_ids" context="{'default_room_id': id}">
                                <list editable="bottom">
                                    <field name="name" readonly="1"/>
                                    <field name="objective"/>
                                    <field name="requested_by_id"/>
                                    <field name="start"/>
                                    <field name="stop"/>
                                    <field name="state"/>
                                </list>
                            </field>
                        </page>
                    </notebook>
                </sheet>
                <chatter/>
            </form>
        </field>
    </record>

    <record id="view_aq_meeting_room_search" model="ir.ui.view">
        <field name="name">aq.meeting.room.search</field>
        <field name="model">aq.meeting.room</field>
        <field name="arch" type="xml">
            <search string="Buscar salas">
                <field name="name"/>
                <field name="code"/>
                <field name="location"/>
                <field name="responsible_id"/>
                <group expand="0" string="Agrupar por">
                    <filter name="group_responsible" string="Responsable" context="{'group_by': 'responsible_id'}"/>
                </group>
            </search>
        </field>
    </record>

    <record id="action_aq_meeting_room" model="ir.actions.act_window">
        <field name="name">Salas de juntas</field>
        <field name="res_model">aq.meeting.room</field>
        <field name="view_mode">kanban,list,form</field>
        <field name="search_view_id" ref="view_aq_meeting_room_search"/>
    </record>
</odoo>
```


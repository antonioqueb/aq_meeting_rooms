## ./__init__.py
```py
from . import models
```

## ./__manifest__.py
```py
{
    'name': 'Alphaqueb Meeting Rooms',
    'version': '18.0.1.0.0',
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

        booking = self.create({
            'room_id': room.id,
            'start': start_dt,
            'stop': stop_dt,
            'objective': objective,
            'agenda': vals.get('agenda') or False,
            'requested_by_id': self.env.user.id,
        })
        booking.action_request()
        return booking._dashboard_booking_payload()

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
```

## ./static/src/scss/dashboard.scss
```scss
.o_aq_rooms {
    --aq-bg: #f6f6f4;
    --aq-surface: #ffffff;
    --aq-border: #e4e4e0;
    --aq-text: #1a1a18;
    --aq-muted: #75756f;
    --aq-accent: #111111;
    --aq-free: #1f8f58;
    --aq-busy: #b63d3d;
    --aq-soon: #b7841e;

    height: 100%;
    overflow-y: auto;
    padding: 20px;
    background: var(--aq-bg);
    color: var(--aq-text);
    font-size: 13px;

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

    /* --- Encabezado --- */
    .aq-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
        margin-bottom: 16px;
    }

    .aq-head-title h1 {
        font-size: 24px;
        font-weight: 700;
        letter-spacing: -0.02em;
    }

    .aq-head-title p {
        margin-top: 2px;
        color: var(--aq-muted);
        font-size: 12.5px;
    }

    .aq-head-tools {
        display: flex;
        align-items: flex-end;
        gap: 10px;
    }

    .aq-date {
        display: flex;
        flex-direction: column;
        gap: 4px;

        span {
            color: var(--aq-muted);
            font-size: 11px;
            font-weight: 600;
        }

        input {
            border: 1px solid var(--aq-border);
            border-radius: 8px;
            padding: 7px 10px;
            background: var(--aq-surface);
            color: var(--aq-text);
            outline: none;
        }
    }

    /* --- Indicadores --- */
    .aq-stats {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 10px;
        margin-bottom: 16px;
    }

    .aq-stat {
        padding: 12px 14px;
        border: 1px solid var(--aq-border);
        border-radius: 10px;
        background: var(--aq-surface);

        span {
            display: block;
            color: var(--aq-muted);
            font-size: 11.5px;
            font-weight: 600;
        }

        strong {
            display: block;
            margin-top: 4px;
            font-size: 24px;
            font-weight: 700;
            letter-spacing: -0.02em;
        }
    }

    /* --- Layout principal --- */
    .aq-grid {
        display: grid;
        grid-template-columns: 0.9fr 1.1fr 0.95fr;
        gap: 14px;
        align-items: start;
    }

    .aq-col {
        border: 1px solid var(--aq-border);
        border-radius: 12px;
        background: var(--aq-surface);
        padding: 14px;
    }

    .aq-col-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 12px;

        h2 {
            font-size: 14px;
            font-weight: 700;
            letter-spacing: -0.01em;
        }

        small {
            color: var(--aq-muted);
            font-size: 11.5px;
        }

        &.aq-mt {
            margin-top: 18px;
            padding-top: 14px;
            border-top: 1px solid var(--aq-border);
        }
    }

    /* --- Lista de salas --- */
    .aq-rooms {
        display: grid;
        gap: 8px;
    }

    .aq-room {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        text-align: left;
        padding: 11px 12px;
        border: 1px solid var(--aq-border);
        border-radius: 10px;
        background: var(--aq-surface);
        cursor: pointer;
        transition: border-color 0.15s ease, background 0.15s ease;

        &:hover {
            border-color: #c9c9c4;
        }

        &.is-active {
            border-color: var(--aq-accent);
            background: #fafafa;
        }
    }

    .aq-room-info {
        flex: 1;
        min-width: 0;

        strong {
            display: block;
            overflow: hidden;
            font-size: 13.5px;
            font-weight: 650;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        small {
            display: block;
            margin-top: 2px;
            color: var(--aq-muted);
            font-size: 11.5px;
        }
    }

    .aq-dot {
        flex: 0 0 auto;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: #c4c4be;

        &.is-free { background: var(--aq-free); }
        &.is-busy { background: var(--aq-busy); }
        &.is-soon { background: var(--aq-soon); }
    }

    /* --- Etiquetas de estado --- */
    .aq-tag {
        flex: 0 0 auto;
        padding: 3px 9px;
        border-radius: 999px;
        border: 1px solid var(--aq-border);
        color: var(--aq-muted);
        font-size: 10.5px;
        font-weight: 650;
        white-space: nowrap;

        &.is-free { border-color: rgba(31, 143, 88, 0.4); color: var(--aq-free); }
        &.is-busy { border-color: rgba(182, 61, 61, 0.4); color: var(--aq-busy); }
        &.is-soon { border-color: rgba(183, 132, 30, 0.4); color: var(--aq-soon); }
        &.is-approved { border-color: rgba(31, 143, 88, 0.4); color: var(--aq-free); }
        &.is-pending { border-color: rgba(183, 132, 30, 0.4); color: var(--aq-soon); }
        &.is-done,
        &.is-muted { color: var(--aq-muted); }
    }

    /* --- Reservas (agenda) --- */
    .aq-bookings {
        display: grid;
        gap: 8px;
    }

    .aq-booking {
        display: grid;
        grid-template-columns: 56px 1fr auto;
        gap: 12px;
        align-items: center;
        padding: 11px 12px;
        border: 1px solid var(--aq-border);
        border-radius: 10px;
        background: var(--aq-surface);
        border-left: 3px solid var(--aq-border);

        &.is-approved { border-left-color: var(--aq-free); }
        &.is-pending { border-left-color: var(--aq-soon); }
        &.is-done,
        &.is-muted { border-left-color: #c4c4be; }
    }

    .aq-booking-time {
        text-align: center;

        strong {
            display: block;
            font-size: 14px;
            font-weight: 700;
        }

        small {
            color: var(--aq-muted);
            font-size: 11px;
        }
    }

    .aq-booking-main {
        min-width: 0;

        strong {
            display: block;
            overflow: hidden;
            font-size: 13px;
            font-weight: 650;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        small {
            display: block;
            margin-top: 2px;
            color: var(--aq-muted);
            font-size: 11.5px;
        }
    }

    .aq-booking-side {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
    }

    .aq-booking-actions {
        display: flex;
        gap: 6px;
    }

    /* --- Formulario --- */
    .aq-form {
        display: grid;
        gap: 11px;
    }

    .aq-field-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 11px;
    }

    .aq-field {
        display: grid;
        gap: 5px;

        span {
            color: var(--aq-muted);
            font-size: 11px;
            font-weight: 600;
        }

        input,
        select,
        textarea {
            width: 100%;
            min-width: 0;
            border: 1px solid var(--aq-border);
            border-radius: 8px;
            padding: 8px 10px;
            background: var(--aq-surface);
            color: var(--aq-text);
            outline: none;

            &:focus {
                border-color: var(--aq-accent);
            }
        }

        textarea {
            min-height: 64px;
            resize: vertical;
        }
    }

    .aq-form-actions {
        display: flex;
        gap: 8px;
        margin-top: 2px;
    }

    /* --- Alertas --- */
    .aq-alert {
        margin: 0;
        padding: 9px 11px;
        border-radius: 8px;
        font-size: 11.5px;
        background: #f8eeee;
        border: 1px solid rgba(182, 61, 61, 0.25);
        color: #8b2f2f;

        &.aq-alert-warn {
            background: #fbf6eb;
            border-color: rgba(183, 132, 30, 0.25);
            color: #6d4a0d;

            ul {
                margin: 4px 0 0;
                padding-left: 16px;
            }
        }
    }

    /* --- Pendientes --- */
    .aq-pending {
        display: grid;
        gap: 8px;
    }

    .aq-pending-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        border: 1px solid var(--aq-border);
        border-radius: 10px;
        background: var(--aq-surface);
    }

    .aq-pending-info {
        min-width: 0;

        strong {
            display: block;
            overflow: hidden;
            font-size: 12.5px;
            font-weight: 650;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        small {
            display: block;
            margin-top: 2px;
            color: var(--aq-muted);
            font-size: 11px;
        }
    }

    .aq-pending-actions {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
    }

    /* --- Botones --- */
    .aq-btn {
        border: 1px solid var(--aq-border);
        border-radius: 8px;
        padding: 7px 13px;
        background: var(--aq-surface);
        color: var(--aq-text);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.14s ease, opacity 0.14s ease;

        &:hover:not(:disabled) {
            background: #f0f0ed;
        }

        &:disabled {
            cursor: not-allowed;
            opacity: 0.45;
        }
    }

    .aq-btn-sm {
        padding: 5px 10px;
        font-size: 11.5px;
    }

    .aq-btn-primary {
        background: var(--aq-accent);
        border-color: var(--aq-accent);
        color: #fff;

        &:hover:not(:disabled) {
            background: #000;
        }
    }

    .aq-btn-ghost {
        background: transparent;
    }

    .aq-btn-danger {
        background: #f1dfdf;
        border-color: rgba(182, 61, 61, 0.3);
        color: #8b2f2f;

        &:hover:not(:disabled) {
            background: #ecd2d2;
        }
    }

    /* --- Vacío / carga --- */
    .aq-empty {
        padding: 22px;
        border: 1px dashed var(--aq-border);
        border-radius: 10px;
        color: var(--aq-muted);
        text-align: center;
        font-size: 12px;
    }

    /* --- Responsivo --- */
    @media (max-width: 1200px) {
        .aq-grid {
            grid-template-columns: 1fr 1fr;
        }

        .aq-grid > .aq-col:last-child {
            grid-column: 1 / -1;
        }
    }

    @media (max-width: 720px) {
        padding: 14px;

        .aq-stats {
            grid-template-columns: repeat(2, 1fr);
        }

        .aq-grid {
            grid-template-columns: 1fr;
        }

        .aq-booking {
            grid-template-columns: 50px 1fr;
        }

        .aq-booking-side {
            grid-column: 1 / -1;
            flex-direction: row;
            align-items: center;
            justify-content: space-between;
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

            <!-- Encabezado -->
            <header class="aq-head">
                <div class="aq-head-title">
                    <h1>Salas de juntas</h1>
                    <p>Consulta disponibilidad y crea solicitudes sujetas a autorización.</p>
                </div>
                <div class="aq-head-tools">
                    <label class="aq-date">
                        <span>Fecha</span>
                        <input type="date" t-att-value="state.date" t-on-input="onDateChange"/>
                    </label>
                    <button type="button" class="aq-btn aq-btn-ghost" t-on-click="refreshDashboard">
                        <i class="fa fa-refresh"/> Actualizar
                    </button>
                </div>
            </header>

            <!-- Indicadores -->
            <section class="aq-stats">
                <div class="aq-stat">
                    <span>Salas</span>
                    <strong t-esc="state.rooms.length"/>
                </div>
                <div class="aq-stat">
                    <span>Disponibles</span>
                    <strong t-esc="freeRoomsCount"/>
                </div>
                <div class="aq-stat">
                    <span>Ocupadas</span>
                    <strong t-esc="busyRoomsCount"/>
                </div>
                <div class="aq-stat">
                    <span t-if="state.canApprove">Pendientes</span>
                    <span t-else="">Mis pendientes</span>
                    <strong t-esc="state.pendingBookings.length"/>
                </div>
            </section>

            <t t-if="state.loading">
                <div class="aq-empty">Cargando disponibilidad…</div>
            </t>

            <t t-else="">
                <div class="aq-grid">

                    <!-- Columna: salas -->
                    <section class="aq-col">
                        <div class="aq-col-head">
                            <h2>Salas</h2>
                            <small t-esc="state.date"/>
                        </div>

                        <div class="aq-rooms" t-if="state.rooms.length">
                            <button t-foreach="state.rooms" t-as="room" t-key="room.id"
                                    type="button"
                                    t-att-data-room-id="room.id"
                                    t-on-click="selectRoom"
                                    t-att-class="'aq-room ' + (state.selectedRoomId === room.id ? 'is-active' : '')">
                                <span t-att-class="'aq-dot ' + statusClass(room.availability_state)"/>
                                <span class="aq-room-info">
                                    <strong t-esc="room.name"/>
                                    <small>
                                        <t t-esc="room.capacity"/> personas
                                        <t t-if="room.location"> · <t t-esc="room.location"/></t>
                                    </small>
                                </span>
                                <span t-att-class="'aq-tag ' + statusClass(room.availability_state)" t-esc="room.availability_label"/>
                            </button>
                        </div>
                        <div class="aq-empty" t-else="">No hay salas registradas.</div>
                    </section>

                    <!-- Columna: agenda de la sala seleccionada -->
                    <section class="aq-col">
                        <div class="aq-col-head">
                            <h2 t-if="selectedRoom">Agenda · <t t-esc="selectedRoom.name"/></h2>
                            <h2 t-else="">Agenda</h2>
                            <button type="button" class="aq-btn aq-btn-ghost aq-btn-sm" t-if="selectedRoom" t-on-click="openRoomCalendar">
                                Calendario
                            </button>
                        </div>

                        <div class="aq-bookings" t-if="selectedBookings.length">
                            <article t-foreach="selectedBookings" t-as="booking" t-key="booking.id"
                                     t-att-class="'aq-booking ' + bookingStateClass(booking.state)">
                                <div class="aq-booking-time">
                                    <strong><t t-esc="formatTime(booking.start)"/></strong>
                                    <small t-esc="formatTime(booking.stop)"/>
                                </div>
                                <div class="aq-booking-main">
                                    <strong t-esc="booking.objective"/>
                                    <small><t t-esc="booking.requested_by"/> · <t t-esc="booking.duration"/> h</small>
                                </div>
                                <div class="aq-booking-side">
                                    <span t-att-class="'aq-tag ' + bookingStateClass(booking.state)" t-esc="booking.state_label"/>
                                    <div class="aq-booking-actions">
                                        <button type="button" class="aq-btn aq-btn-sm" t-att-data-booking-id="booking.id" t-on-click="openBooking">Abrir</button>
                                        <button type="button" class="aq-btn aq-btn-sm" t-if="booking.can_open_minute" t-att-data-booking-id="booking.id" t-on-click="openMinute">Minuta</button>
                                    </div>
                                </div>
                            </article>
                        </div>
                        <div class="aq-empty" t-else="">Sin reservas para esta sala en la fecha seleccionada.</div>
                    </section>

                    <!-- Columna: nueva solicitud + pendientes -->
                    <aside class="aq-col">
                        <div class="aq-col-head">
                            <h2>Nueva solicitud</h2>
                        </div>

                        <div class="aq-form">
                            <label class="aq-field">
                                <span>Sala</span>
                                <select t-att-value="state.selectedRoomId || ''" t-on-change="onRoomSelect">
                                    <option value="">Selecciona…</option>
                                    <option t-foreach="state.rooms" t-as="room" t-key="room.id" t-att-value="room.id" t-att-selected="state.selectedRoomId === room.id">
                                        <t t-esc="room.name"/>
                                    </option>
                                </select>
                            </label>
                            <div class="aq-field-row">
                                <label class="aq-field">
                                    <span>Inicio</span>
                                    <input type="datetime-local" t-model="state.form.start"/>
                                </label>
                                <label class="aq-field">
                                    <span>Fin</span>
                                    <input type="datetime-local" t-model="state.form.stop"/>
                                </label>
                            </div>
                            <label class="aq-field">
                                <span>Objetivo</span>
                                <input type="text" t-model="state.form.objective" placeholder="Ej. Revisión semanal"/>
                            </label>
                            <label class="aq-field">
                                <span>Agenda</span>
                                <textarea t-model="state.form.agenda" placeholder="Puntos a tratar (opcional)"/>
                            </label>

                            <p class="aq-alert" t-if="hasInvalidSlot">La hora de fin debe ser mayor que la de inicio.</p>
                            <div class="aq-alert aq-alert-warn" t-if="quickConflicts.length">
                                <strong>Horario ocupado</strong>
                                <ul>
                                    <li t-foreach="quickConflicts" t-as="booking" t-key="booking.id">
                                        <t t-esc="formatTime(booking.start)"/>–<t t-esc="formatTime(booking.stop)"/> · <t t-esc="booking.objective"/>
                                    </li>
                                </ul>
                            </div>

                            <div class="aq-form-actions">
                                <button type="button" class="aq-btn aq-btn-primary"
                                        t-att-disabled="!state.selectedRoomId || hasInvalidSlot || quickConflicts.length"
                                        t-on-click="createQuickRequest">
                                    Enviar solicitud
                                </button>
                                <button type="button" class="aq-btn aq-btn-ghost" t-on-click="openFullRequestForm">Formulario completo</button>
                            </div>
                        </div>

                        <div class="aq-col-head aq-mt">
                            <h2 t-if="state.canApprove">Pendientes por autorizar</h2>
                            <h2 t-else="">Mis solicitudes pendientes</h2>
                        </div>

                        <div class="aq-pending" t-if="state.pendingBookings.length">
                            <article t-foreach="state.pendingBookings" t-as="booking" t-key="booking.id" class="aq-pending-row">
                                <div class="aq-pending-info">
                                    <strong t-esc="booking.objective"/>
                                    <small><t t-esc="booking.room_name"/> · <t t-esc="formatTime(booking.start)"/>–<t t-esc="formatTime(booking.stop)"/></small>
                                </div>
                                <div class="aq-pending-actions">
                                    <button type="button" class="aq-btn aq-btn-sm" t-att-data-booking-id="booking.id" t-on-click="openBooking">Abrir</button>
                                    <button type="button" class="aq-btn aq-btn-sm aq-btn-primary" t-if="state.canApprove" t-att-data-booking-id="booking.id" t-on-click="approveBooking">Autorizar</button>
                                    <button type="button" class="aq-btn aq-btn-sm aq-btn-danger" t-if="state.canApprove" t-att-data-booking-id="booking.id" t-on-click="rejectBooking">Rechazar</button>
                                </div>
                            </article>
                        </div>
                        <div class="aq-empty" t-else="">No hay solicitudes pendientes.</div>
                    </aside>

                </div>
            </t>
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
                <field name="booking_id"/>
                <field name="room_id"/>
                <field name="meeting_start"/>
                <field name="capture_by_id"/>
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
                <field name="responsible_partner_id" optional="show"/>
                <field name="due_date" optional="show"/>
                <field name="priority" optional="hide"/>
                <field name="task_state" optional="show"/>
                <field name="description" optional="hide"/>
            </list>
        </field>
    </record>

    <record id="view_aq_meeting_minute_line_form" model="ir.ui.view">
        <field name="name">aq.meeting.minute.line.form</field>
        <field name="model">aq.meeting.minute.line</field>
        <field name="arch" type="xml">
            <form string="Elemento de minuta">
                <sheet>
                    <group>
                        <group string="Clasificación">
                            <field name="minute_id" readonly="1"/>
                            <field name="parent_id" domain="[('minute_id', '=', minute_id)]"/>
                            <field name="sequence"/>
                            <field name="item_type"/>
                        </group>
                        <group string="Seguimiento" invisible="item_type == 'section'">
                            <field name="responsible_partner_id"/>
                            <field name="due_date"/>
                            <field name="priority"/>
                            <field name="task_state" invisible="item_type != 'task'"/>
                        </group>
                    </group>
                    <group string="Contenido">
                        <field name="name" placeholder="Título claro del punto, acuerdo, decisión o tarea"/>
                        <field name="description" placeholder="Detalle suficiente para entender el contexto, conclusión y seguimiento."/>
                    </group>
                </sheet>
            </form>
        </field>
    </record>

    <record id="view_aq_meeting_minute_form" model="ir.ui.view">
        <field name="name">aq.meeting.minute.form</field>
        <field name="model">aq.meeting.minute</field>
        <field name="arch" type="xml">
            <form string="Minuta corporativa">
                <header>
                    <field name="line_count" invisible="1"/>
                    <button name="action_seed_structure" type="object" string="Crear estructura base" class="btn-secondary" invisible="line_count != 0"/>
                    <button name="action_confirm" type="object" string="Confirmar minuta" class="btn-primary" invisible="state != 'draft'"/>
                    <button name="action_reset_draft" type="object" string="Regresar a borrador" class="btn-secondary" invisible="state == 'draft'"/>
                    <button name="action_print_minute" type="object" string="Generar reporte" class="btn-secondary"/>
                    <button name="action_share_by_email" type="object" string="Compartir con participantes" class="btn-primary" invisible="state == 'draft'"/>
                    <field name="state" widget="statusbar" statusbar_visible="draft,confirmed,shared"/>
                </header>
                <sheet>
                    <div class="oe_title">
                        <label for="name"/>
                        <h1><field name="name" readonly="1"/></h1>
                        <label for="objective"/>
                        <h2><field name="objective" readonly="1" placeholder="Objetivo de la reunión"/></h2>
                    </div>

                    <div class="alert alert-info" role="alert">
                        Captura la minuta por secciones: primero resumen, después puntos tratados, acuerdos, decisiones, tareas y riesgos. La pestaña “Estructura completa” queda para ajustes jerárquicos avanzados.
                    </div>

                    <group>
                        <group string="Datos de la reunión">
                            <field name="booking_id" options="{'no_create_edit': True}"/>
                            <field name="room_id" readonly="1"/>
                            <field name="meeting_start" readonly="1"/>
                            <field name="meeting_stop" readonly="1"/>
                            <field name="requested_by_id" readonly="1"/>
                        </group>
                        <group string="Responsables y participantes">
                            <field name="capture_by_id"/>
                            <field name="chair_partner_id"/>
                            <field name="participant_partner_ids" widget="many2many_tags" placeholder="Personas que participaron o deben recibir seguimiento"/>
                            <field name="shared_date" readonly="1" invisible="not shared_date"/>
                        </group>
                    </group>

                    <notebook>
                        <page string="1. Resumen">
                            <group>
                                <field name="summary" placeholder="Qué se revisó, por qué era importante y cuál fue la conclusión general."/>
                                <field name="agreements_summary" placeholder="Acuerdos generales que aplican a toda la reunión."/>
                                <field name="risk_notes" placeholder="Riesgos, bloqueos o temas pendientes de resolución."/>
                            </group>
                        </page>

                        <page string="2. Puntos tratados">
                            <field name="note_line_ids" context="{'default_minute_id': id, 'default_item_type': 'note'}">
                                <list editable="bottom" decoration-muted="item_type == 'section'">
                                    <field name="sequence" widget="handle"/>
                                    <field name="item_type" invisible="1"/>
                                    <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]" optional="hide"/>
                                    <field name="name" string="Punto tratado"/>
                                    <field name="responsible_partner_id" optional="show"/>
                                    <field name="description" optional="hide"/>
                                </list>
                                <form string="Punto tratado">
                                    <sheet>
                                        <group>
                                            <group string="Ubicación">
                                                <field name="item_type" readonly="1"/>
                                                <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]"/>
                                                <field name="sequence"/>
                                            </group>
                                            <group string="Referencia">
                                                <field name="responsible_partner_id"/>
                                            </group>
                                        </group>
                                        <group string="Contenido">
                                            <field name="name" placeholder="Tema o punto revisado"/>
                                            <field name="description" placeholder="Contexto, datos revisados y conclusión del punto."/>
                                        </group>
                                    </sheet>
                                </form>
                            </field>
                        </page>

                        <page string="3. Acuerdos y decisiones">
                            <separator string="Acuerdos"/>
                            <field name="agreement_line_ids" context="{'default_minute_id': id, 'default_item_type': 'agreement'}">
                                <list editable="bottom">
                                    <field name="sequence" widget="handle"/>
                                    <field name="item_type" invisible="1"/>
                                    <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]" optional="hide"/>
                                    <field name="name" string="Acuerdo"/>
                                    <field name="responsible_partner_id" string="Responsable" optional="show"/>
                                    <field name="due_date" string="Fecha compromiso" optional="show"/>
                                    <field name="description" optional="hide"/>
                                </list>
                                <form string="Acuerdo">
                                    <sheet>
                                        <group>
                                            <group>
                                                <field name="item_type" readonly="1"/>
                                                <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]"/>
                                                <field name="sequence"/>
                                            </group>
                                            <group>
                                                <field name="responsible_partner_id"/>
                                                <field name="due_date"/>
                                                <field name="priority"/>
                                            </group>
                                        </group>
                                        <group string="Contenido">
                                            <field name="name" placeholder="Acuerdo claro y verificable"/>
                                            <field name="description" placeholder="Detalle del acuerdo, alcance y condición de cumplimiento."/>
                                        </group>
                                    </sheet>
                                </form>
                            </field>

                            <separator string="Decisiones"/>
                            <field name="decision_line_ids" context="{'default_minute_id': id, 'default_item_type': 'decision'}">
                                <list editable="bottom">
                                    <field name="sequence" widget="handle"/>
                                    <field name="item_type" invisible="1"/>
                                    <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]" optional="hide"/>
                                    <field name="name" string="Decisión"/>
                                    <field name="responsible_partner_id" string="Responsable" optional="show"/>
                                    <field name="description" optional="hide"/>
                                </list>
                                <form string="Decisión">
                                    <sheet>
                                        <group>
                                            <group>
                                                <field name="item_type" readonly="1"/>
                                                <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]"/>
                                                <field name="sequence"/>
                                            </group>
                                            <group>
                                                <field name="responsible_partner_id"/>
                                                <field name="priority"/>
                                            </group>
                                        </group>
                                        <group string="Contenido">
                                            <field name="name" placeholder="Decisión tomada"/>
                                            <field name="description" placeholder="Criterio, impacto y alcance de la decisión."/>
                                        </group>
                                    </sheet>
                                </form>
                            </field>
                        </page>

                        <page string="4. Tareas">
                            <field name="task_line_ids" context="{'default_minute_id': id, 'default_item_type': 'task', 'default_task_state': 'todo'}">
                                <list editable="bottom" decoration-success="task_state == 'done'" decoration-warning="task_state == 'blocked'" decoration-info="task_state == 'in_progress'">
                                    <field name="sequence" widget="handle"/>
                                    <field name="item_type" invisible="1"/>
                                    <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]" optional="hide"/>
                                    <field name="name" string="Tarea / acción"/>
                                    <field name="responsible_partner_id"/>
                                    <field name="due_date"/>
                                    <field name="priority"/>
                                    <field name="task_state"/>
                                    <field name="description" optional="hide"/>
                                </list>
                                <form string="Tarea de seguimiento">
                                    <sheet>
                                        <group>
                                            <group string="Acción">
                                                <field name="item_type" readonly="1"/>
                                                <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]"/>
                                                <field name="sequence"/>
                                                <field name="name" placeholder="Acción concreta a ejecutar"/>
                                            </group>
                                            <group string="Seguimiento">
                                                <field name="responsible_partner_id"/>
                                                <field name="due_date"/>
                                                <field name="priority"/>
                                                <field name="task_state"/>
                                            </group>
                                        </group>
                                        <group string="Detalle">
                                            <field name="description" placeholder="Resultado esperado, evidencia de cierre y dependencias."/>
                                        </group>
                                    </sheet>
                                </form>
                            </field>
                        </page>

                        <page string="5. Riesgos">
                            <field name="risk_line_ids" context="{'default_minute_id': id, 'default_item_type': 'risk'}">
                                <list editable="bottom" decoration-warning="priority in ['2', '3']">
                                    <field name="sequence" widget="handle"/>
                                    <field name="item_type" invisible="1"/>
                                    <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]" optional="hide"/>
                                    <field name="name" string="Riesgo / bloqueo"/>
                                    <field name="responsible_partner_id" string="Responsable" optional="show"/>
                                    <field name="priority"/>
                                    <field name="description" optional="hide"/>
                                </list>
                                <form string="Riesgo o bloqueo">
                                    <sheet>
                                        <group>
                                            <group>
                                                <field name="item_type" readonly="1"/>
                                                <field name="parent_id" domain="[('minute_id', '=', parent.id), ('item_type', '=', 'section')]"/>
                                                <field name="sequence"/>
                                                <field name="name" placeholder="Riesgo o bloqueo detectado"/>
                                            </group>
                                            <group>
                                                <field name="responsible_partner_id"/>
                                                <field name="priority"/>
                                            </group>
                                        </group>
                                        <group string="Detalle">
                                            <field name="description" placeholder="Impacto, mitigación y siguiente paso recomendado."/>
                                        </group>
                                    </sheet>
                                </form>
                            </field>
                        </page>

                        <page string="Estructura completa">
                            <group>
                                <field name="section_line_ids" context="{'default_minute_id': id, 'default_item_type': 'section'}">
                                    <list editable="bottom" decoration-bf="1">
                                        <field name="sequence" widget="handle"/>
                                        <field name="item_type" invisible="1"/>
                                        <field name="name" string="Sección"/>
                                        <field name="description" optional="hide"/>
                                    </list>
                                </field>
                            </group>
                            <separator string="Todos los elementos"/>
                            <field name="line_ids" context="{'default_minute_id': id}">
                                <list editable="bottom" decoration-bf="item_type == 'section'" decoration-info="item_type == 'task'" decoration-warning="task_state == 'blocked'">
                                    <field name="sequence" widget="handle"/>
                                    <field name="parent_id" domain="[('minute_id', '=', parent.id)]" optional="show"/>
                                    <field name="item_type"/>
                                    <field name="name"/>
                                    <field name="responsible_partner_id" optional="show"/>
                                    <field name="due_date" optional="show"/>
                                    <field name="priority" optional="hide"/>
                                    <field name="task_state" optional="show"/>
                                    <field name="description" optional="hide"/>
                                </list>
                                <form>
                                    <sheet>
                                        <group>
                                            <group string="Jerarquía">
                                                <field name="parent_id" domain="[('minute_id', '=', parent.id)]"/>
                                                <field name="item_type"/>
                                                <field name="sequence"/>
                                            </group>
                                            <group string="Seguimiento">
                                                <field name="responsible_partner_id"/>
                                                <field name="due_date"/>
                                                <field name="priority"/>
                                                <field name="task_state" invisible="item_type != 'task'"/>
                                            </group>
                                        </group>
                                        <group string="Contenido">
                                            <field name="name"/>
                                            <field name="description"/>
                                        </group>
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


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

    @api.model_create_multi
    def create(self, vals_list):
        for vals in vals_list:
            if vals.get('name', 'Nueva') == 'Nueva':
                vals['name'] = self.env['ir.sequence'].next_by_code('aq.meeting.minute') or 'Nueva'
            if vals.get('booking_id') and not vals.get('participant_partner_ids'):
                booking = self.env['aq.meeting.room.booking'].browse(vals['booking_id'])
                vals['participant_partner_ids'] = [(6, 0, booking.participant_partner_ids.ids)]
        return super().create(vals_list)

    def action_seed_structure(self):
        for minute in self:
            if minute.line_ids:
                raise UserError(_('La minuta ya contiene líneas.'))
            section_context = self.env['aq.meeting.minute.line'].create({
                'minute_id': minute.id,
                'sequence': 10,
                'item_type': 'section',
                'name': _('1. Contexto y objetivo'),
                'description': _('Captura el objetivo, alcance y contexto principal de la reunión.'),
            })
            self.env['aq.meeting.minute.line'].create({
                'minute_id': minute.id,
                'sequence': 20,
                'parent_id': section_context.id,
                'item_type': 'note',
                'name': _('Puntos discutidos'),
            })
            section_decisions = self.env['aq.meeting.minute.line'].create({
                'minute_id': minute.id,
                'sequence': 30,
                'item_type': 'section',
                'name': _('2. Decisiones y acuerdos'),
            })
            self.env['aq.meeting.minute.line'].create({
                'minute_id': minute.id,
                'sequence': 40,
                'parent_id': section_decisions.id,
                'item_type': 'decision',
                'name': _('Decisión clave'),
            })
            section_tasks = self.env['aq.meeting.minute.line'].create({
                'minute_id': minute.id,
                'sequence': 50,
                'item_type': 'section',
                'name': _('3. Tareas y seguimiento'),
            })
            self.env['aq.meeting.minute.line'].create({
                'minute_id': minute.id,
                'sequence': 60,
                'parent_id': section_tasks.id,
                'item_type': 'task',
                'name': _('Tarea clave'),
                'task_state': 'todo',
            })
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
            ('note', 'Nota'),
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

    @api.depends('parent_id')
    def _compute_depth(self):
        for line in self:
            depth = 0
            parent = line.parent_id
            while parent:
                depth += 1
                parent = parent.parent_id
            line.depth = depth

    @api.constrains('parent_id', 'minute_id')
    def _check_parent_minute(self):
        for line in self:
            if line.parent_id and line.parent_id.minute_id != line.minute_id:
                raise ValidationError(_('El elemento padre debe pertenecer a la misma minuta.'))

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

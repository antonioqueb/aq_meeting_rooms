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

/**
 * ============================================================================
 * ระบบสารบรรณอิเล็กทรอนิกส์หลายหน่วยงาน (Multi-tenant e-Document Registry)
 * Backend: Google Apps Script V8
 * Files: Code.gs, index.html, dashboard.html
 * ============================================================================
 *
 * ขอบเขตของไฟล์นี้
 * - Web App routing สำหรับ index.html และ dashboard.html
 * - Google Sheets schema initialization และ schema migration แบบเพิ่มคอลัมน์
 * - Multi-tenant organization isolation
 * - Authentication, password hashing, sessions, login throttling
 * - Users, roles, permissions, departments, lookup data, settings
 * - Incoming / outgoing registers, registration sequences, assignments, actions
 * - Notifications, dashboards, reports, audit logs
 * - ImgBB image upload adapter
 * - Cloudflare R2 private file-storage adapter ผ่าน Cloudflare Worker
 *
 * การตั้งค่าก่อน Deploy
 * 1) สร้าง Google Apps Script project และเพิ่มไฟล์ HTML ชื่อ index และ dashboard
 * 2) ตั้ง Script Properties ตามรายการ CONFIGURATION ด้านล่าง
 * 3) รัน initializeDatabase_() จาก Apps Script editor หนึ่งครั้ง
 * 4) ตั้ง INITIAL_ADMIN_USERNAME และ INITIAL_ADMIN_PASSWORD ใน Script Properties
 * 5) รัน bootstrapSuperAdmin_() จาก Apps Script editor หนึ่งครั้ง
 * 6) ลบ INITIAL_ADMIN_USERNAME และ INITIAL_ADMIN_PASSWORD ออกจาก Script Properties
 * 7) Deploy เป็น Web app และกำหนดสิทธิ์การเข้าถึงให้เหมาะสมกับนโยบายองค์กร
 *
 * CONFIGURATION (Project Settings > Script Properties)
 * - SPREADSHEET_ID             : ID ของ Google Spreadsheet กลาง
 * - APP_TIMEZONE               : เช่น Asia/Bangkok
 * - PASSWORD_PEPPER            : secret สุ่มยาวอย่างน้อย 32 ตัวอักษร (ถ้าไม่มีระบบจะสร้างให้)
 * - SESSION_SIGNING_SECRET     : secret สุ่มยาวอย่างน้อย 32 ตัวอักษร (ถ้าไม่มีระบบจะสร้างให้)
 * - IMGBB_API_KEY              : API key ของ ImgBB (ใช้เฉพาะโลโก้/avatar/ภาพทั่วไป)
 * - FILE_SERVICE_URL           : HTTPS URL ของ Cloudflare Worker ที่เชื่อม R2
 * - FILE_SERVICE_TOKEN         : Worker Secret API_TOKEN (เก็บใน Script Properties เท่านั้น)
 * - FILE_STORAGE_PROVIDER      : CLOUDFLARE_R2
 * - FILE_MAX_UPLOAD_BYTES      : ขนาดไฟล์สูงสุด เช่น 6291456 (6 MB)
 *
 * Cloudflare Worker contract ที่ Code.gs คาดหวัง
 * POST   {FILE_SERVICE_URL}/upload
 *   Authorization: Bearer {FILE_SERVICE_TOKEN}
 *   JSON: { fileName, mimeType, base64Data, folder }
 *   Response: { success:true, key, fileName, mimeType, size }
 * GET    {FILE_SERVICE_URL}/download-link?key={R2 object key}
 *   Authorization: Bearer {FILE_SERVICE_TOKEN}
 *   Response: { success:true, downloadUrl, expiresAt }
 * DELETE {FILE_SERVICE_URL}/delete?key={R2 object key}
 *   Authorization: Bearer {FILE_SERVICE_TOKEN}
 * GET    {FILE_SERVICE_URL}/health
 *
 * ไฟล์ใน R2 เป็น Private; การดาวน์โหลดต้องผ่านการตรวจสิทธิ์และการแยกหน่วยงาน
 * ใน Code.gs ก่อนสร้าง signed URL อายุสั้น จึงไม่บันทึก public URL ลง Sheets
 *
 * หมายเหตุด้านข้อจำกัด
 * - Worker ชุดนี้สร้าง signed download URL ไม่ได้สร้าง ZIP ที่เข้ารหัส AES-256
 * - การส่ง Base64 ผ่าน Apps Script เพิ่มการใช้หน่วยความจำ จึงคงการจำกัดไฟล์ฝั่งหน้าเว็บไว้ที่ 6 MB
 * - ไม่ส่งไฟล์ไป Google Drive และไม่เผย Worker token ให้ HTML
 * - PDF แบบ Canvas + TH Sarabun PSK และ Excel/CSV download เป็นงานฝั่ง dashboard.html
 *   โดย Code.gs เตรียม API ข้อมูลจริงให้แล้ว
 * - ไม่ควรใช้ ImgBB กับหนังสือราชการหรือเอกสารลับ/ข้อมูลส่วนบุคคล
 *
 * SECURITY NOTES
 * - ห้ามส่ง password_hash, password_salt, session token hash, secret หรือ raw password ลง log
 * - รหัสผ่านบัญชีใช้ PBKDF2-HMAC-SHA256 พร้อม salt และ pepper ฝั่ง Script Properties
 * - Token ที่เก็บใน Sessions เป็น hash เท่านั้น
 * - ทุก API ที่เกี่ยวกับข้อมูลต้องส่ง session token และตรวจ permission/tenant บน server
 * - Google Sheets ไม่ใช่ฐานข้อมูลที่มี row-level security; จำกัดสิทธิ์ Spreadsheet ให้เข้มงวด
 * - การ deploy แบบ Execute as owner ทำให้ทุกการเรียกทำงานด้วยสิทธิ์เจ้าของสคริปต์
 *   จึงต้องจำกัดผู้เข้าถึง Web App และไม่เปิดเผย URL/Spreadsheet แก่บุคคลที่ไม่เกี่ยวข้อง
 * ============================================================================
 */

/* -------------------------------------------------------------------------- */
/* 01. CONSTANTS AND SCHEMA                                                    */
/* -------------------------------------------------------------------------- */

var APP_ = Object.freeze({
  NAME: 'ระบบสารบรรณอิเล็กทรอนิกส์',
  VERSION: '1.0.0',
  SCHEMA_VERSION: '1.0.0',
  SYSTEM_ORG_CODE: 'SYSTEM',
  DEFAULT_TIMEZONE: 'Asia/Bangkok',
  SESSION_HOURS: 8,
  REMEMBER_SESSION_DAYS: 30,
  LOGIN_FAILURE_LIMIT: 5,
  LOGIN_LOCK_MINUTES: 15,
  PBKDF2_ITERATIONS: 60000,
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 200,
  MAX_REPORT_ROWS: 10000,
  FILE_DOWNLOAD_TTL_SECONDS: 300,
  MAX_UPLOAD_BYTES_DEFAULT: 6291456
});

var SHEET_SCHEMA_ = Object.freeze({
  SystemMeta: [
    'meta_key', 'meta_value', 'updated_at'
  ],
  Organizations: [
    'org_id', 'org_code', 'org_name', 'org_short_name', 'org_type', 'logo_url',
    'address', 'building', 'village', 'subdistrict', 'district', 'province',
    'postal_code', 'phone', 'email', 'website', 'contact_name', 'status',
    'created_at', 'created_by', 'updated_at', 'updated_by', 'notes'
  ],
  Users: [
    'user_id', 'org_id', 'username', 'password_hash', 'password_salt',
    'full_name', 'email', 'phone', 'position', 'department_id', 'role_id',
    'avatar_url', 'status', 'must_change_password', 'failed_login_count',
    'locked_until', 'last_login_at', 'created_at', 'created_by', 'updated_at',
    'updated_by'
  ],
  Departments: [
    'department_id', 'org_id', 'department_code', 'department_name',
    'parent_department_id', 'head_user_id', 'phone', 'email', 'status',
    'sort_order', 'created_at', 'updated_at'
  ],
  Roles: [
    'role_id', 'org_id', 'role_code', 'role_name', 'role_scope',
    'description', 'is_system', 'status', 'created_at', 'updated_at'
  ],
  Permissions: [
    'permission_id', 'permission_code', 'module_key', 'action_key',
    'permission_name', 'description', 'status'
  ],
  RolePermissions: [
    'role_permission_id', 'role_id', 'permission_code', 'is_allowed',
    'created_at', 'updated_at'
  ],
  BookTypes: [
    'book_type_id', 'org_id', 'type_code', 'type_name', 'direction_scope',
    'description', 'is_system', 'status', 'sort_order', 'created_at', 'updated_at'
  ],
  BookCategories: [
    'category_id', 'org_id', 'category_code', 'category_name', 'description',
    'status', 'sort_order', 'created_at', 'updated_at'
  ],
  UrgencyLevels: [
    'urgency_id', 'org_id', 'urgency_code', 'urgency_name', 'sla_days',
    'sort_order', 'status', 'created_at', 'updated_at'
  ],
  SecrecyLevels: [
    'secrecy_id', 'org_id', 'secrecy_code', 'secrecy_name', 'access_policy',
    'description', 'sort_order', 'status', 'created_at', 'updated_at'
  ],
  IncomingBooks: [
    'incoming_id', 'org_id', 'fiscal_year', 'registration_seq', 'registration_no',
    'receive_date', 'receive_time', 'letter_no', 'letter_date', 'sender_org_name',
    'sender_person_name', 'sender_contact', 'subject', 'summary', 'book_type_id',
    'category_id', 'urgency_id', 'secrecy_id', 'addressed_to',
    'assigned_department_id', 'assigned_user_id', 'received_by_user_id',
    'due_date', 'status', 'primary_attachment_id', 'remarks', 'created_at',
    'created_by', 'updated_at', 'updated_by', 'deleted_at', 'deleted_by'
  ],
  OutgoingBooks: [
    'outgoing_id', 'org_id', 'fiscal_year', 'registration_seq', 'registration_no',
    'register_date', 'send_date', 'send_time', 'letter_no', 'letter_date',
    'recipient_org_name', 'recipient_person_name', 'recipient_address',
    'recipient_email', 'recipient_phone', 'subject', 'summary', 'book_type_id',
    'category_id', 'urgency_id', 'secrecy_id', 'addressed_to', 'signatory_user_id',
    'send_method', 'tracking_no', 'dispatched_at', 'sent_status',
    'primary_attachment_id', 'assigned_department_id', 'created_by', 'created_at',
    'updated_by', 'updated_at', 'deleted_at', 'deleted_by'
  ],
  BookAssignments: [
    'assignment_id', 'org_id', 'book_direction', 'book_id', 'from_user_id',
    'to_user_id', 'to_department_id', 'assigned_at', 'due_date', 'instruction',
    'status', 'completed_at', 'completion_note', 'created_by', 'created_at',
    'updated_at'
  ],
  BookActions: [
    'action_id', 'org_id', 'book_direction', 'book_id', 'action_type',
    'action_title', 'action_detail', 'previous_status', 'new_status',
    'actor_user_id', 'actor_department_id', 'action_at', 'source_ip',
    'attachment_id'
  ],
  BookAttachments: [
    'attachment_id', 'org_id', 'book_direction', 'book_id', 'file_category',
    'file_name', 'original_file_name', 'mime_type', 'file_extension',
    'file_size_bytes', 'storage_provider', 'storage_key', 'file_url',
    'thumbnail_url', 'is_primary', 'access_level', 'uploaded_by', 'uploaded_at',
    'status'
  ],
  NumberSequences: [
    'sequence_id', 'org_id', 'book_direction', 'fiscal_year', 'prefix',
    'last_number', 'digit_width', 'number_pattern', 'reset_rule', 'updated_at',
    'updated_by'
  ],
  Notifications: [
    'notification_id', 'org_id', 'recipient_user_id', 'notification_type',
    'title', 'message', 'reference_type', 'reference_id', 'is_read', 'read_at',
    'created_at', 'expires_at'
  ],
  SystemSettings: [
    'setting_id', 'org_id', 'setting_key', 'setting_value', 'value_type',
    'description', 'is_public', 'updated_at', 'updated_by'
  ],
  Sessions: [
    'session_id', 'org_id', 'user_id', 'token_hash', 'created_at', 'expires_at',
    'last_seen_at', 'revoked_at', 'remember_me', 'user_agent'
  ],
  LoginLogs: [
    'login_log_id', 'org_id', 'user_id', 'username_attempt', 'success',
    'fail_reason', 'logged_in_at', 'ip_address', 'user_agent'
  ],
  PasswordResetRequests: [
    'reset_id', 'org_id', 'user_id', 'reset_token_hash', 'requested_at',
    'expires_at', 'used_at', 'requested_by', 'status'
  ],
  AuditLogs: [
    'audit_log_id', 'org_id', 'actor_user_id', 'actor_role_id', 'action_type',
    'module_key', 'entity_type', 'entity_id', 'before_json', 'after_json',
    'ip_address', 'user_agent', 'occurred_at'
  ],
  ReportLogs: [
    'report_id', 'org_id', 'report_type', 'filters_json', 'file_name',
    'generated_by', 'generated_at', 'record_count', 'status'
  ],
  FileDownloadLogs: [
    'download_id', 'org_id', 'user_id', 'attachment_id', 'storage_provider',
    'storage_key', 'encrypted_file_name', 'password_hash', 'created_at',
    'expires_at', 'status', 'downloaded_at', 'source_ip', 'user_agent'
  ]
});

var PERMISSION_DEFINITIONS_ = [
  ['dashboard.view', 'dashboard', 'view', 'ดู Dashboard'],
  ['organizations.view', 'organizations', 'view', 'ดูหน่วยงาน'],
  ['organizations.manage', 'organizations', 'manage', 'จัดการหน่วยงาน'],
  ['users.view', 'users', 'view', 'ดูผู้ใช้'],
  ['users.manage', 'users', 'manage', 'จัดการผู้ใช้'],
  ['roles.manage', 'roles', 'manage', 'จัดการบทบาทและสิทธิ์'],
  ['departments.view', 'departments', 'view', 'ดูฝ่าย/กอง'],
  ['departments.manage', 'departments', 'manage', 'จัดการฝ่าย/กอง'],
  ['books.incoming.view', 'incoming', 'view', 'ดูทะเบียนหนังสือรับ'],
  ['books.incoming.create', 'incoming', 'create', 'ลงทะเบียนหนังสือรับ'],
  ['books.incoming.update', 'incoming', 'update', 'แก้ไขหนังสือรับ'],
  ['books.incoming.delete', 'incoming', 'delete', 'ยกเลิกหนังสือรับ'],
  ['books.outgoing.view', 'outgoing', 'view', 'ดูทะเบียนหนังสือส่ง'],
  ['books.outgoing.create', 'outgoing', 'create', 'ลงทะเบียนหนังสือส่ง'],
  ['books.outgoing.update', 'outgoing', 'update', 'แก้ไขหนังสือส่ง'],
  ['books.outgoing.delete', 'outgoing', 'delete', 'ยกเลิกหนังสือส่ง'],
  ['workflow.assign', 'workflow', 'assign', 'มอบหมายและส่งต่อหนังสือ'],
  ['workflow.action', 'workflow', 'action', 'บันทึกการพิจารณาและสั่งการ'],
  ['workflow.complete', 'workflow', 'complete', 'บันทึกผลการดำเนินงาน'],
  ['reports.view', 'reports', 'view', 'ดูรายงานและสถิติ'],
  ['reports.export', 'reports', 'export', 'ส่งออกรายงาน'],
  ['files.upload', 'files', 'upload', 'แนบไฟล์'],
  ['files.download', 'files', 'download', 'ดาวน์โหลดไฟล์'],
  ['settings.manage', 'settings', 'manage', 'ตั้งค่าหน่วยงาน'],
  ['audit.view', 'audit', 'view', 'ดูประวัติการใช้งาน']
];

var DEFAULT_ROLE_PERMISSIONS_ = Object.freeze({
  SUPER_ADMIN: ['*'],
  ORG_ADMIN: [
    'dashboard.view', 'users.view', 'users.manage', 'roles.manage',
    'departments.view', 'departments.manage', 'books.incoming.view',
    'books.incoming.create', 'books.incoming.update', 'books.incoming.delete',
    'books.outgoing.view', 'books.outgoing.create', 'books.outgoing.update',
    'books.outgoing.delete', 'workflow.assign', 'workflow.action',
    'workflow.complete', 'reports.view', 'reports.export', 'files.upload',
    'files.download', 'settings.manage', 'audit.view'
  ],
  REGISTRAR: [
    'dashboard.view', 'departments.view', 'books.incoming.view',
    'books.incoming.create', 'books.incoming.update', 'books.outgoing.view',
    'books.outgoing.create', 'books.outgoing.update', 'workflow.assign',
    'workflow.action', 'reports.view', 'reports.export', 'files.upload',
    'files.download'
  ],
  EXECUTIVE: [
    'dashboard.view', 'books.incoming.view', 'books.outgoing.view',
    'workflow.action', 'reports.view', 'files.download'
  ],
  DEPARTMENT_HEAD: [
    'dashboard.view', 'departments.view', 'books.incoming.view',
    'books.outgoing.view', 'workflow.assign', 'workflow.action',
    'workflow.complete', 'reports.view', 'files.upload', 'files.download'
  ],
  STAFF: [
    'dashboard.view', 'books.incoming.view', 'books.outgoing.view',
    'workflow.complete', 'files.upload', 'files.download'
  ],
  AUDITOR: [
    'dashboard.view', 'books.incoming.view', 'books.outgoing.view',
    'reports.view', 'audit.view', 'files.download'
  ]
});

var STANDARD_ROLES_ = [
  ['ORG_ADMIN', 'ผู้ดูแลระบบหน่วยงาน', 'ORGANIZATION'],
  ['REGISTRAR', 'เจ้าหน้าที่สารบรรณ', 'ORGANIZATION'],
  ['EXECUTIVE', 'ผู้บริหาร', 'ORGANIZATION'],
  ['DEPARTMENT_HEAD', 'หัวหน้าฝ่าย/กอง', 'ORGANIZATION'],
  ['STAFF', 'เจ้าหน้าที่ทั่วไป', 'ORGANIZATION'],
  ['AUDITOR', 'ผู้ตรวจสอบ', 'ORGANIZATION']
];

var BOOK_STATUSES_ = [
  'เข้าใหม่', 'รอเสนอ', 'รอมอบหมาย', 'ดำเนินการ', 'ดำเนินการแล้ว',
  'รอตอบกลับ', 'เกินกำหนด', 'ยกเลิก'
];

/* -------------------------------------------------------------------------- */
/* 02. WEB APP ROUTING                                                          */
/* -------------------------------------------------------------------------- */

function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) ? String(e.parameter.page) : 'index';
  var fileName = page === 'dashboard' ? 'dashboard' : 'index';
  var template = HtmlService.createTemplateFromFile(fileName);
  template.appName = APP_.NAME;
  template.appVersion = APP_.VERSION;
  template.webAppUrl = ScriptApp.getService().getUrl() || '';
  return template.evaluate()
    .setTitle(APP_.NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* -------------------------------------------------------------------------- */
/* 03. DATABASE INITIALIZATION AND MIGRATIONS                                  */
/* -------------------------------------------------------------------------- */

/** Run manually from Apps Script editor. Safe to run repeatedly. */
function initializeDatabase_() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = getSpreadsheet_();
    var result = [];
    Object.keys(SHEET_SCHEMA_).forEach(function (sheetName) {
      result.push(ensureSheetSchema_(ss, sheetName, SHEET_SCHEMA_[sheetName]));
    });
    ensureMetaValue_('schema_version', APP_.SCHEMA_VERSION);
    ensureMetaValue_('app_version', APP_.VERSION);
    ensureMetaValue_('initialized_at', nowIso_());
    ensureSecretProperty_('PASSWORD_PEPPER');
    ensureSecretProperty_('SESSION_SIGNING_SECRET');
    seedPermissionDefinitions_();
    ensureGlobalSuperAdminRole_();
    return {
      success: true,
      spreadsheetId: ss.getId(),
      schemaVersion: APP_.SCHEMA_VERSION,
      sheets: result,
      message: 'สร้าง/ตรวจสอบโครงสร้างฐานข้อมูลเรียบร้อยแล้ว'
    };
  } finally {
    lock.releaseLock();
  }
}

/** Run manually after setting INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD. */
function bootstrapSuperAdmin_() {
  var props = PropertiesService.getScriptProperties();
  var username = String(props.getProperty('INITIAL_ADMIN_USERNAME') || '').trim();
  var password = String(props.getProperty('INITIAL_ADMIN_PASSWORD') || '');
  if (!username || !password) {
    throw new Error('กรุณากำหนด INITIAL_ADMIN_USERNAME และ INITIAL_ADMIN_PASSWORD ใน Script Properties ก่อน');
  }
  if (password.length < 12) {
    throw new Error('รหัสผ่าน Super Admin ต้องมีอย่างน้อย 12 ตัวอักษร');
  }
  var users = getRecords_('Users');
  var existing = users.some(function (u) {
    return String(u.org_id || '') === '' && String(u.username).toLowerCase() === username.toLowerCase();
  });
  if (existing) throw new Error('มีบัญชีผู้ใช้นี้อยู่แล้ว');
  var role = findOne_('Roles', function (r) { return r.role_code === 'SUPER_ADMIN'; });
  if (!role) role = ensureGlobalSuperAdminRole_();
  var salt = randomHex_(16);
  var userId = newId_();
  insertRecord_('Users', {
    user_id: userId,
    org_id: '',
    username: username,
    password_hash: hashPassword_(password, salt),
    password_salt: salt,
    full_name: 'ผู้ดูแลระบบส่วนกลาง',
    email: '',
    phone: '',
    position: 'Super Admin',
    department_id: '',
    role_id: role.role_id,
    avatar_url: '',
    status: 'ACTIVE',
    must_change_password: false,
    failed_login_count: 0,
    locked_until: '',
    created_at: nowIso_(),
    created_by: 'SYSTEM',
    updated_at: nowIso_(),
    updated_by: 'SYSTEM'
  });
  auditSystem_('CREATE', 'users', 'Users', userId, null, { username: username, role: 'SUPER_ADMIN' });
  props.deleteProperty('INITIAL_ADMIN_USERNAME');
  props.deleteProperty('INITIAL_ADMIN_PASSWORD');
  return { success: true, username: username, message: 'สร้าง Super Admin เรียบร้อย กรุณาลบ/เก็บข้อมูลสำรองอย่างปลอดภัย' };
}

function ensureSheetSchema_(ss, sheetName, requiredHeaders) {
  var sheet = ss.getSheetByName(sheetName);
  var created = false;
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    created = true;
  }
  var lastColumn = Math.max(sheet.getLastColumn(), 1);
  var addedColumns = [];
  var currentHeaders = sheet.getRange(1, 1, 1, lastColumn).getValues()[0]
    .map(function (v) { return String(v || '').trim(); });
  if (created || currentHeaders.every(function (v) { return !v; })) {
    sheet.getRange(1, 1, 1, requiredHeaders.length).setValues([requiredHeaders]);
    currentHeaders = requiredHeaders.slice();
  } else {
    var seen = {};
    currentHeaders.forEach(function (h) {
      if (!h) return;
      if (seen[h]) throw new Error('พบชื่อคอลัมน์ซ้ำใน Sheet ' + sheetName + ': ' + h);
      seen[h] = true;
    });
    var missing = requiredHeaders.filter(function (h) { return currentHeaders.indexOf(h) === -1; });
    addedColumns = missing.slice();
    if (missing.length) {
      var startCol = currentHeaders.length + 1;
      sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
      currentHeaders = currentHeaders.concat(missing);
    }
  }
  sheet.setFrozenRows(1);
  var width = Math.max(sheet.getLastColumn(), requiredHeaders.length);
  var headerRange = sheet.getRange(1, 1, 1, width);
  headerRange.setFontWeight('bold').setWrap(true).setVerticalAlignment('middle');
  sheet.setRowHeight(1, 34);
  if (!sheet.getFilter() && sheet.getLastColumn() > 0) {
    sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), sheet.getLastColumn()).createFilter();
  }
  formatSheetColumns_(sheet, currentHeaders);
  return {
    sheet: sheetName,
    created: created,
    addedColumns: addedColumns.length,
    columnCount: currentHeaders.filter(function (h) { return !!h; }).length,
    dataRows: Math.max(sheet.getLastRow() - 1, 0)
  };
}

function formatSheetColumns_(sheet, headers) {
  var rowCount = Math.max(sheet.getMaxRows() - 1, 1);
  headers.forEach(function (header, index) {
    if (!header) return;
    var col = index + 1;
    if (/(^|_)(date|at|until|time)$/.test(header) || ['due_date', 'letter_date', 'receive_date', 'send_date', 'register_date', 'expires_at', 'locked_until'].indexOf(header) >= 0) {
      sheet.getRange(2, col, rowCount, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    }
    if (/(^|_)(seq|number|count|size_bytes|days|order)$/.test(header) || ['last_number', 'digit_width', 'sla_days', 'sort_order', 'record_count', 'file_size_bytes', 'failed_login_count'].indexOf(header) >= 0) {
      sheet.getRange(2, col, rowCount, 1).setNumberFormat('0');
    }
  });
}

function seedPermissionDefinitions_() {
  var existing = getRecords_('Permissions');
  var existingCodes = {};
  existing.forEach(function (p) { existingCodes[p.permission_code] = true; });
  PERMISSION_DEFINITIONS_.forEach(function (p) {
    if (!existingCodes[p[0]]) {
      insertRecord_('Permissions', {
        permission_id: newId_(), permission_code: p[0], module_key: p[1],
        action_key: p[2], permission_name: p[3], description: '', status: 'ACTIVE'
      });
    }
  });
}

function ensureGlobalSuperAdminRole_() {
  var role = findOne_('Roles', function (r) { return r.role_code === 'SUPER_ADMIN' && !r.org_id; });
  if (!role) {
    role = {
      role_id: newId_(), org_id: '', role_code: 'SUPER_ADMIN',
      role_name: 'ผู้ดูแลระบบส่วนกลาง', role_scope: 'SYSTEM',
      description: 'จัดการระบบทุกหน่วยงาน', is_system: true, status: 'ACTIVE',
      created_at: nowIso_(), updated_at: nowIso_()
    };
    insertRecord_('Roles', role);
  }
  seedRolePermissions_(role.role_id, DEFAULT_ROLE_PERMISSIONS_.SUPER_ADMIN);
  return role;
}

function seedOrganizationDefaults_(orgId) {
  STANDARD_ROLES_.forEach(function (definition) {
    var roleCode = definition[0];
    var role = findOne_('Roles', function (r) { return r.org_id === orgId && r.role_code === roleCode; });
    if (!role) {
      role = {
        role_id: newId_(), org_id: orgId, role_code: roleCode,
        role_name: definition[1], role_scope: definition[2],
        description: '', is_system: true, status: 'ACTIVE',
        created_at: nowIso_(), updated_at: nowIso_()
      };
      insertRecord_('Roles', role);
    }
    seedRolePermissions_(role.role_id, DEFAULT_ROLE_PERMISSIONS_[roleCode] || []);
  });
  var defaultSettings = [
    ['fiscal_year_start_month', '10', 'number', 'เดือนเริ่มต้นปีงบประมาณ'],
    ['calendar_era_offset', '543', 'number', 'ค่าปี พ.ศ.'],
    ['registration_incoming_prefix', 'รับ', 'string', 'คำนำหน้าเลขทะเบียนรับ'],
    ['registration_outgoing_prefix', 'ส่ง', 'string', 'คำนำหน้าเลขทะเบียนส่ง'],
    ['registration_digit_width', '4', 'number', 'จำนวนหลักเลขทะเบียน'],
    ['organization_timezone', getTimezone_(), 'string', 'เขตเวลาองค์กร']
  ];
  defaultSettings.forEach(function (s) {
    var exists = findOne_('SystemSettings', function (r) { return r.org_id === orgId && r.setting_key === s[0]; });
    if (!exists) insertRecord_('SystemSettings', {
      setting_id: newId_(), org_id: orgId, setting_key: s[0], setting_value: s[1],
      value_type: s[2], description: s[3], is_public: true,
      updated_at: nowIso_(), updated_by: 'SYSTEM'
    });
  });
  seedDefaultLookups_(orgId);
}

function seedRolePermissions_(roleId, permissionCodes) {
  var existing = getRecords_('RolePermissions').filter(function (p) { return p.role_id === roleId; });
  var existingCodes = {};
  existing.forEach(function (p) { existingCodes[p.permission_code] = true; });
  permissionCodes.forEach(function (code) {
    if (code === '*') return;
    if (!existingCodes[code]) insertRecord_('RolePermissions', {
      role_permission_id: newId_(), role_id: roleId, permission_code: code,
      is_allowed: true, created_at: nowIso_(), updated_at: nowIso_()
    });
  });
}

function seedDefaultLookups_(orgId) {
  var typeRows = [
    ['GENERAL', 'หนังสือทั่วไป', 'BOTH'],
    ['EXTERNAL', 'หนังสือภายนอก', 'BOTH'],
    ['INTERNAL', 'หนังสือภายใน', 'BOTH'],
    ['ORDER', 'คำสั่ง', 'OUTGOING'],
    ['ANNOUNCEMENT', 'ประกาศ', 'OUTGOING']
  ];
  typeRows.forEach(function (x, i) {
    if (!findOne_('BookTypes', function (r) { return r.org_id === orgId && r.type_code === x[0]; })) {
      insertRecord_('BookTypes', {
        book_type_id: newId_(), org_id: orgId, type_code: x[0], type_name: x[1],
        direction_scope: x[2], description: '', is_system: true, status: 'ACTIVE',
        sort_order: i + 1, created_at: nowIso_(), updated_at: nowIso_()
      });
    }
  });
  var categories = [['GENERAL', 'ทั่วไป'], ['PERSONNEL', 'งานบุคคล'], ['FINANCE', 'การเงินและพัสดุ'], ['LEGAL', 'กฎหมาย'], ['ADMIN', 'งานบริหาร']];
  categories.forEach(function (x, i) {
    if (!findOne_('BookCategories', function (r) { return r.org_id === orgId && r.category_code === x[0]; })) {
      insertRecord_('BookCategories', {
        category_id: newId_(), org_id: orgId, category_code: x[0], category_name: x[1],
        description: '', status: 'ACTIVE', sort_order: i + 1,
        created_at: nowIso_(), updated_at: nowIso_()
      });
    }
  });
  var urgencies = [['NORMAL', 'ปกติ', 7], ['URGENT', 'ด่วน', 3], ['VERY_URGENT', 'ด่วนมาก', 2], ['MOST_URGENT', 'ด่วนที่สุด', 1]];
  urgencies.forEach(function (x, i) {
    if (!findOne_('UrgencyLevels', function (r) { return r.org_id === orgId && r.urgency_code === x[0]; })) {
      insertRecord_('UrgencyLevels', {
        urgency_id: newId_(), org_id: orgId, urgency_code: x[0], urgency_name: x[1],
        sla_days: x[2], sort_order: i + 1, status: 'ACTIVE',
        created_at: nowIso_(), updated_at: nowIso_()
      });
    }
  });
  var secrecy = [['PUBLIC', 'ปกติ', 'ORG'], ['CONFIDENTIAL', 'ลับ', 'RESTRICTED'], ['SECRET', 'ลับมาก', 'RESTRICTED'], ['TOP_SECRET', 'ลับที่สุด', 'RESTRICTED']];
  secrecy.forEach(function (x, i) {
    if (!findOne_('SecrecyLevels', function (r) { return r.org_id === orgId && r.secrecy_code === x[0]; })) {
      insertRecord_('SecrecyLevels', {
        secrecy_id: newId_(), org_id: orgId, secrecy_code: x[0], secrecy_name: x[1],
        access_policy: x[2], description: '', sort_order: i + 1, status: 'ACTIVE',
        created_at: nowIso_(), updated_at: nowIso_()
      });
    }
  });
}

/* -------------------------------------------------------------------------- */
/* 04. PUBLIC API: ORGANIZATION CHECK AND AUTHENTICATION                       */
/* -------------------------------------------------------------------------- */

function apiValidateOrganizationCode(orgCode) {
  try {
    var code = normalizeOrgCode_(orgCode);
    if (code === APP_.SYSTEM_ORG_CODE) {
      return ok_({ org_code: code, org_name: 'ระบบส่วนกลาง', org_short_name: 'ส่วนกลาง', logo_url: '', is_system: true });
    }
    var org = findOne_('Organizations', function (r) { return normalizeOrgCode_(r.org_code) === code; });
    if (!org || org.status !== 'ACTIVE') return fail_('ORG_NOT_AVAILABLE', 'ไม่พบรหัสหน่วยงาน หรือหน่วยงานถูกระงับการใช้งาน');
    return ok_(publicOrganization_(org));
  } catch (err) {
    return errorResponse_(err);
  }
}

function apiLogin(payload) {
  try {
    payload = payload || {};
    var orgCode = normalizeOrgCode_(payload.orgCode);
    var username = String(payload.username || '').trim();
    var password = String(payload.password || '');
    var rememberMe = payload.rememberMe === true;
    var userAgent = safeText_(payload.userAgent, 300);
    if (!orgCode || !username || !password) return fail_('INVALID_INPUT', 'กรุณากรอกรหัสหน่วยงาน ชื่อผู้ใช้ และรหัสผ่าน');

    var org = null;
    var orgId = '';
    if (orgCode !== APP_.SYSTEM_ORG_CODE) {
      org = findOne_('Organizations', function (r) { return normalizeOrgCode_(r.org_code) === orgCode; });
      if (!org || org.status !== 'ACTIVE') {
        writeLoginLog_('', '', username, false, 'ORG_NOT_AVAILABLE', userAgent);
        return fail_('LOGIN_FAILED', 'รหัสหน่วยงานหรือข้อมูลเข้าสู่ระบบไม่ถูกต้อง');
      }
      orgId = org.org_id;
    }

    var throttleKey = 'LOGIN_' + orgCode + '_' + username.toLowerCase();
    var cache = CacheService.getScriptCache();
    var lockUntil = Number(cache.get(throttleKey) || 0);
    if (lockUntil && Date.now() < lockUntil) {
      return fail_('LOGIN_LOCKED', 'บัญชีถูกระงับชั่วคราว กรุณาลองใหม่ภายหลัง');
    }

    var user = findOne_('Users', function (r) {
      return String(r.org_id || '') === orgId && String(r.username || '').toLowerCase() === username.toLowerCase();
    });
    if (!user || user.status !== 'ACTIVE') {
      registerLoginFailure_(throttleKey);
      writeLoginLog_(orgId, user ? user.user_id : '', username, false, 'INVALID_CREDENTIALS', userAgent);
      return fail_('LOGIN_FAILED', 'รหัสหน่วยงานหรือข้อมูลเข้าสู่ระบบไม่ถูกต้อง');
    }
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      return fail_('LOGIN_LOCKED', 'บัญชีถูกระงับชั่วคราว กรุณาติดต่อผู้ดูแลระบบ');
    }
    if (!verifyPassword_(password, user.password_salt, user.password_hash)) {
      registerLoginFailure_(throttleKey);
      var failedCount = Number(user.failed_login_count || 0) + 1;
      var lockedUntil = failedCount >= APP_.LOGIN_FAILURE_LIMIT
        ? new Date(Date.now() + APP_.LOGIN_LOCK_MINUTES * 60000).toISOString() : '';
      updateRecordById_('Users', 'user_id', user.user_id, {
        failed_login_count: failedCount,
        locked_until: lockedUntil,
        updated_at: nowIso_()
      });
      writeLoginLog_(orgId, user.user_id, username, false, 'INVALID_CREDENTIALS', userAgent);
      return fail_('LOGIN_FAILED', 'รหัสหน่วยงานหรือข้อมูลเข้าสู่ระบบไม่ถูกต้อง');
    }

    cache.remove(throttleKey);
    updateRecordById_('Users', 'user_id', user.user_id, {
      failed_login_count: 0, locked_until: '', last_login_at: nowIso_(), updated_at: nowIso_()
    });
    var token = newSessionToken_();
    var sessionId = newId_();
    var expiresAt = rememberMe
      ? new Date(Date.now() + APP_.REMEMBER_SESSION_DAYS * 86400000).toISOString()
      : new Date(Date.now() + APP_.SESSION_HOURS * 3600000).toISOString();
    insertRecord_('Sessions', {
      session_id: sessionId, org_id: orgId, user_id: user.user_id,
      token_hash: hashToken_(token), created_at: nowIso_(), expires_at: expiresAt,
      last_seen_at: nowIso_(), revoked_at: '', remember_me: rememberMe, user_agent: userAgent
    });
    writeLoginLog_(orgId, user.user_id, username, true, '', userAgent);
    auditUser_(user, 'LOGIN', 'auth', 'Sessions', sessionId, null, { remember_me: rememberMe });
    return ok_({
      token: token,
      expiresAt: expiresAt,
      rememberMe: rememberMe,
      mustChangePassword: user.must_change_password === true || String(user.must_change_password) === 'true',
      user: publicUser_(user),
      organization: org ? publicOrganization_(org) : { org_code: APP_.SYSTEM_ORG_CODE, org_name: 'ระบบส่วนกลาง', org_short_name: 'ส่วนกลาง', logo_url: '' }
    });
  } catch (err) {
    return errorResponse_(err);
  }
}

function apiLogout(token) {
  try {
    var ctx = requireSession_(token);
    var session = ctx.session;
    updateRecordById_('Sessions', 'session_id', session.session_id, { revoked_at: nowIso_(), last_seen_at: nowIso_() });
    auditUser_(ctx.user, 'LOGOUT', 'auth', 'Sessions', session.session_id, null, null);
    return ok_({ loggedOut: true });
  } catch (err) {
    return errorResponse_(err);
  }
}

function apiGetAppBootstrap(token) {
  try {
    var ctx = requireSession_(token);
    var permissions = getPermissionsForRole_(ctx.role);
    var organization = ctx.org ? publicOrganization_(ctx.org) : {
      org_code: APP_.SYSTEM_ORG_CODE, org_name: 'ระบบส่วนกลาง', org_short_name: 'ส่วนกลาง', logo_url: ''
    };
    return ok_({
      app: { name: APP_.NAME, version: APP_.VERSION },
      user: publicUser_(ctx.user), role: publicRole_(ctx.role),
      organization: organization,
      permissions: permissions,
      isSuperAdmin: ctx.isSuperAdmin,
      menus: buildMenuForPermissions_(permissions, ctx.isSuperAdmin)
    });
  } catch (err) {
    return errorResponse_(err);
  }
}

function apiChangePassword(token, payload) {
  try {
    var ctx = requireSession_(token);
    payload = payload || {};
    var currentPassword = String(payload.currentPassword || '');
    var newPassword = String(payload.newPassword || '');
    if (newPassword.length < 12) return fail_('WEAK_PASSWORD', 'รหัสผ่านใหม่ต้องมีอย่างน้อย 12 ตัวอักษร');
    if (!verifyPassword_(currentPassword, ctx.user.password_salt, ctx.user.password_hash)) {
      return fail_('INVALID_CURRENT_PASSWORD', 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
    }
    var salt = randomHex_(16);
    var before = { must_change_password: ctx.user.must_change_password };
    updateRecordById_('Users', 'user_id', ctx.user.user_id, {
      password_salt: salt, password_hash: hashPassword_(newPassword, salt),
      must_change_password: false, updated_at: nowIso_(), updated_by: ctx.user.user_id
    });
    auditUser_(ctx.user, 'CHANGE_PASSWORD', 'users', 'Users', ctx.user.user_id, before, { must_change_password: false });
    return ok_({ changed: true });
  } catch (err) {
    return errorResponse_(err);
  }
}

function apiRequestPasswordReset(payload) {
  try {
    payload = payload || {};
    var orgCode = normalizeOrgCode_(payload.orgCode);
    var username = String(payload.username || '').trim();
    var email = String(payload.email || '').trim().toLowerCase();
    if (!orgCode || !username) return fail_('INVALID_INPUT', 'กรุณากรอกรหัสหน่วยงานและชื่อผู้ใช้');
    var org = orgCode === APP_.SYSTEM_ORG_CODE ? null : findOne_('Organizations', function (r) { return normalizeOrgCode_(r.org_code) === orgCode && r.status === 'ACTIVE'; });
    var orgId = org ? org.org_id : '';
    var orgCodeValid = orgCode === APP_.SYSTEM_ORG_CODE || !!org;
    var user = orgCodeValid ? findOne_('Users', function (r) {
      return String(r.org_id || '') === orgId && String(r.username || '').toLowerCase() === username.toLowerCase() &&
        (!email || String(r.email || '').toLowerCase() === email);
    }) : null;
    if (user) {
      var resetId = newId_();
      insertRecord_('PasswordResetRequests', {
        reset_id: resetId, org_id: orgId, user_id: user.user_id,
        reset_token_hash: '', requested_at: nowIso_(),
        expires_at: new Date(Date.now() + 24 * 3600000).toISOString(),
        used_at: '', requested_by: 'SELF_SERVICE', status: 'PENDING_ADMIN'
      });
      getRecords_('Users').filter(function (adminUser) {
        if (adminUser.org_id !== orgId || adminUser.status !== 'ACTIVE') return false;
        var adminRole = findById_('Roles', 'role_id', adminUser.role_id);
        return adminRole && adminRole.role_code === 'ORG_ADMIN';
      }).forEach(function (adminUser) {
        createNotification_(orgId, adminUser.user_id, 'PASSWORD_RESET_REQUEST', 'มีคำขอรีเซ็ตรหัสผ่าน', 'มีผู้ใช้ส่งคำขอรีเซ็ตรหัสผ่าน กรุณาตรวจสอบรายการคำขอ', 'PASSWORD_RESET', resetId);
      });
    }
    // ตอบข้อความเดียวกันเสมอ เพื่อไม่เปิดเผยว่ามีบัญชีผู้ใช้นี้หรือไม่
    return ok_({ requested: true, message: 'หากข้อมูลตรงกับบัญชีในระบบ คำขอจะถูกส่งให้ผู้ดูแลตรวจสอบ' });
  } catch (err) {
    return errorResponse_(err);
  }
}


function apiListPasswordResetRequests(token, filters) {
  try {
    var ctx = requirePermission_(token, 'users.manage');
    filters = filters || {};
    var orgId = resolveOrgScope_(ctx, filters.org_id);
    var rows = getRecords_('PasswordResetRequests').filter(function (r) {
      return (ctx.isSuperAdmin && !filters.org_id ? true : r.org_id === orgId) &&
        (!filters.status || r.status === filters.status);
    });
    rows.sort(function (a, b) { return new Date(b.requested_at).getTime() - new Date(a.requested_at).getTime(); });
    return ok_({ items: rows.map(function (request) {
      var user = findById_('Users', 'user_id', request.user_id);
      return {
        reset_id: request.reset_id, org_id: request.org_id, user_id: request.user_id,
        username: user ? user.username : '', full_name: user ? user.full_name : '',
        requested_at: request.requested_at, expires_at: request.expires_at,
        status: request.status, used_at: request.used_at
      };
    }), total: rows.length });
  } catch (err) { return errorResponse_(err); }
}

function apiResolvePasswordResetRequest(token, resetId, decision, customPassword) {
  try {
    var ctx = requirePermission_(token, 'users.manage');
    var request = findById_('PasswordResetRequests', 'reset_id', resetId);
    if (!request || request.status !== 'PENDING_ADMIN') return fail_('NOT_FOUND', 'ไม่พบคำขอที่รออนุมัติ');
    assertTenantAccess_(ctx, request.org_id);
    if (new Date(request.expires_at).getTime() < Date.now()) {
      updateRecordById_('PasswordResetRequests', 'reset_id', resetId, { status: 'EXPIRED' });
      return fail_('REQUEST_EXPIRED', 'คำขอรีเซ็ตรหัสผ่านหมดอายุแล้ว');
    }
    if (decision === 'REJECT') {
      updateRecordById_('PasswordResetRequests', 'reset_id', resetId, { status: 'REJECTED', used_at: nowIso_() });
      auditUser_(ctx.user, 'REJECT_PASSWORD_RESET', 'users', 'PasswordResetRequests', resetId, { status: 'PENDING_ADMIN' }, { status: 'REJECTED' });
      return ok_({ approved: false, rejected: true });
    }
    if (decision !== 'APPROVE') return fail_('INVALID_DECISION', 'การตัดสินใจไม่ถูกต้อง');
    var user = findById_('Users', 'user_id', request.user_id);
    if (!user || user.status !== 'ACTIVE') return fail_('USER_NOT_AVAILABLE', 'บัญชีผู้ใช้ไม่พร้อมใช้งาน');
    if (!ctx.isSuperAdmin && user.org_id !== ctx.orgId) throw appError_('TENANT_FORBIDDEN', 'ไม่สามารถรีเซ็ตรหัสผ่านผู้ใช้ต่างหน่วยงาน');
    var temporaryPassword = String(customPassword || randomPassword_(18));
    if (temporaryPassword.length < 12) return fail_('WEAK_PASSWORD', 'รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร');
    var salt = randomHex_(16);
    updateRecordById_('Users', 'user_id', user.user_id, {
      password_salt: salt, password_hash: hashPassword_(temporaryPassword, salt),
      must_change_password: true, failed_login_count: 0, locked_until: '',
      updated_at: nowIso_(), updated_by: ctx.user.user_id
    });
    revokeSessionsForUser_(user.user_id);
    updateRecordById_('PasswordResetRequests', 'reset_id', resetId, { status: 'APPROVED', used_at: nowIso_(), requested_by: ctx.user.user_id });
    auditUser_(ctx.user, 'APPROVE_PASSWORD_RESET', 'users', 'Users', user.user_id, null, { must_change_password: true, reset_id: resetId });
    return ok_({ approved: true, temporaryPassword: temporaryPassword, mustChangePassword: true });
  } catch (err) { return errorResponse_(err); }
}

function apiGetPermissionCatalog(token, roleId) {
  try {
    var ctx = requirePermission_(token, 'roles.manage');
    var role = findById_('Roles', 'role_id', roleId);
    if (!role) return fail_('NOT_FOUND', 'ไม่พบบทบาท');
    if (!ctx.isSuperAdmin && role.org_id !== ctx.orgId) throw appError_('TENANT_FORBIDDEN', 'ไม่สามารถดูสิทธิ์ของบทบาทต่างหน่วยงาน');
    var selected = getRecords_('RolePermissions').filter(function (p) { return p.role_id === roleId && truthy_(p.is_allowed); }).map(function (p) { return p.permission_code; });
    return ok_({
      role: publicRole_(role),
      permissions: getRecords_('Permissions').filter(function (p) { return p.status === 'ACTIVE'; }),
      selected: selected
    });
  } catch (err) { return errorResponse_(err); }
}

/* -------------------------------------------------------------------------- */
/* 05. ORGANIZATION MANAGEMENT                                                 */
/* -------------------------------------------------------------------------- */

function apiListOrganizations(token, filters) {
  try {
    var ctx = requirePermission_(token, 'organizations.view');
    if (!ctx.isSuperAdmin) throw appError_('FORBIDDEN', 'ไม่มีสิทธิ์ดูข้อมูลหน่วยงานทั้งหมด');
    filters = filters || {};
    var q = String(filters.search || '').toLowerCase();
    var status = String(filters.status || '');
    var rows = getRecords_('Organizations').filter(function (r) {
      return (!status || r.status === status) && (!q || [r.org_code, r.org_name, r.org_short_name, r.province].join(' ').toLowerCase().indexOf(q) >= 0);
    });
    rows.sort(function (a, b) { return String(a.org_name).localeCompare(String(b.org_name), 'th'); });
    return ok_({ items: rows.map(publicOrganization_), total: rows.length });
  } catch (err) { return errorResponse_(err); }
}

function apiSaveOrganization(token, payload) {
  try {
    var ctx = requirePermission_(token, 'organizations.manage');
    if (!ctx.isSuperAdmin) throw appError_('FORBIDDEN', 'เฉพาะ Super Admin เท่านั้น');
    payload = payload || {};
    var orgId = String(payload.org_id || '').trim();
    var orgCode = normalizeOrgCode_(payload.org_code);
    var orgName = safeText_(payload.org_name, 250);
    if (!orgCode || orgCode === APP_.SYSTEM_ORG_CODE || !orgName) return fail_('INVALID_INPUT', 'กรุณาระบุรหัสและชื่อหน่วยงานให้ถูกต้อง');
    var duplicate = findOne_('Organizations', function (r) {
      return normalizeOrgCode_(r.org_code) === orgCode && r.org_id !== orgId;
    });
    if (duplicate) return fail_('DUPLICATE_ORG_CODE', 'รหัสหน่วยงานนี้ถูกใช้แล้ว');
    var before = orgId ? findById_('Organizations', 'org_id', orgId) : null;
    if (orgId && !before) return fail_('NOT_FOUND', 'ไม่พบหน่วยงานที่ต้องการแก้ไข');
    var record = {
      org_id: orgId || newId_(), org_code: orgCode, org_name: orgName,
      org_short_name: safeText_(payload.org_short_name, 120), org_type: safeText_(payload.org_type, 100),
      logo_url: safeHttpsUrl_(payload.logo_url), address: safeText_(payload.address, 500),
      building: safeText_(payload.building, 200), village: safeText_(payload.village, 200),
      subdistrict: safeText_(payload.subdistrict, 120), district: safeText_(payload.district, 120),
      province: safeText_(payload.province, 120), postal_code: safeText_(payload.postal_code, 20),
      phone: safeText_(payload.phone, 50), email: safeText_(payload.email, 150),
      website: safeHttpsUrl_(payload.website), contact_name: safeText_(payload.contact_name, 150),
      status: payload.status === 'SUSPENDED' ? 'SUSPENDED' : (before ? before.status : 'ACTIVE'),
      notes: safeText_(payload.notes, 2000), updated_at: nowIso_(), updated_by: ctx.user.user_id
    };
    if (before) {
      updateRecordById_('Organizations', 'org_id', orgId, record);
    } else {
      record.created_at = nowIso_();
      record.created_by = ctx.user.user_id;
      insertRecord_('Organizations', record);
      seedOrganizationDefaults_(record.org_id);
    }
    auditUser_(ctx.user, before ? 'UPDATE' : 'CREATE', 'organizations', 'Organizations', record.org_id, before, record);
    return ok_({ organization: publicOrganization_(record) });
  } catch (err) { return errorResponse_(err); }
}

function apiSetOrganizationStatus(token, orgId, status) {
  try {
    var ctx = requirePermission_(token, 'organizations.manage');
    if (!ctx.isSuperAdmin) throw appError_('FORBIDDEN', 'เฉพาะ Super Admin เท่านั้น');
    if (['ACTIVE', 'SUSPENDED', 'INACTIVE', 'DELETED'].indexOf(status) < 0) return fail_('INVALID_STATUS', 'สถานะไม่ถูกต้อง');
    var org = findById_('Organizations', 'org_id', orgId);
    if (!org) return fail_('NOT_FOUND', 'ไม่พบหน่วยงาน');
    updateRecordById_('Organizations', 'org_id', orgId, { status: status, updated_at: nowIso_(), updated_by: ctx.user.user_id });
    if (status !== 'ACTIVE') revokeSessionsForOrg_(orgId);
    auditUser_(ctx.user, 'CHANGE_STATUS', 'organizations', 'Organizations', orgId, { status: org.status }, { status: status });
    return ok_({ org_id: orgId, status: status });
  } catch (err) { return errorResponse_(err); }
}

/* -------------------------------------------------------------------------- */
/* 06. USER, ROLE AND DEPARTMENT MANAGEMENT                                    */
/* -------------------------------------------------------------------------- */

function apiListUsers(token, filters) {
  try {
    var ctx = requirePermission_(token, 'users.view');
    filters = filters || {};
    var orgId = resolveOrgScope_(ctx, filters.org_id);
    var q = String(filters.search || '').toLowerCase();
    var status = String(filters.status || '');
    var rows = getRecords_('Users').filter(function (u) {
      return (ctx.isSuperAdmin && !filters.org_id ? true : u.org_id === orgId) &&
        (!status || u.status === status) &&
        (!q || [u.username, u.full_name, u.email, u.position].join(' ').toLowerCase().indexOf(q) >= 0);
    });
    rows.sort(function (a, b) { return String(a.full_name).localeCompare(String(b.full_name), 'th'); });
    return ok_({ items: rows.map(publicUser_), total: rows.length });
  } catch (err) { return errorResponse_(err); }
}

function apiSaveUser(token, payload) {
  try {
    var ctx = requirePermission_(token, 'users.manage');
    payload = payload || {};
    var orgId = resolveOrgScope_(ctx, payload.org_id);
    requireOrganizationTarget_(orgId);
    var userId = String(payload.user_id || '').trim();
    var username = safeText_(payload.username, 100);
    var fullName = safeText_(payload.full_name, 200);
    if (!username || !fullName) return fail_('INVALID_INPUT', 'กรุณาระบุชื่อผู้ใช้และชื่อ-นามสกุล');
    var duplicate = findOne_('Users', function (u) {
      return String(u.org_id || '') === String(orgId || '') && String(u.username).toLowerCase() === username.toLowerCase() && u.user_id !== userId;
    });
    if (duplicate) return fail_('DUPLICATE_USERNAME', 'ชื่อผู้ใช้นี้ถูกใช้แล้วในหน่วยงาน');
    var before = userId ? findById_('Users', 'user_id', userId) : null;
    if (userId && !before) return fail_('NOT_FOUND', 'ไม่พบผู้ใช้ที่ต้องการแก้ไข');
    if (before && !ctx.isSuperAdmin && before.org_id !== orgId) throw appError_('TENANT_FORBIDDEN', 'ไม่สามารถแก้ไขผู้ใช้ต่างหน่วยงาน');
    var roleId = String(payload.role_id || (before && before.role_id) || '');
    var role = findById_('Roles', 'role_id', roleId);
    if (!role || role.org_id !== orgId || role.role_code === 'SUPER_ADMIN') return fail_('INVALID_ROLE', 'ไม่พบบทบาทที่เลือกในหน่วยงานนี้');
    var departmentId = String(payload.department_id || '');
    if (departmentId) {
      var dep = findById_('Departments', 'department_id', departmentId);
      if (!dep || dep.org_id !== orgId) return fail_('INVALID_DEPARTMENT', 'ฝ่าย/กองไม่ถูกต้อง');
    }
    var record = {
      user_id: userId || newId_(), org_id: orgId || '', username: username,
      full_name: fullName, email: safeText_(payload.email, 150), phone: safeText_(payload.phone, 50),
      position: safeText_(payload.position, 150), department_id: departmentId,
      role_id: roleId, avatar_url: safeHttpsUrl_(payload.avatar_url),
      status: ['ACTIVE', 'INACTIVE', 'SUSPENDED'].indexOf(payload.status) >= 0 ? payload.status : (before ? before.status : 'ACTIVE'),
      must_change_password: before ? before.must_change_password : true,
      updated_at: nowIso_(), updated_by: ctx.user.user_id
    };
    var temporaryPassword = '';
    if (!before) {
      temporaryPassword = randomPassword_(18);
      var salt = randomHex_(16);
      record.password_salt = salt;
      record.password_hash = hashPassword_(temporaryPassword, salt);
      record.failed_login_count = 0;
      record.locked_until = '';
      record.created_at = nowIso_();
      record.created_by = ctx.user.user_id;
      insertRecord_('Users', record);
    } else {
      updateRecordById_('Users', 'user_id', userId, record);
    }
    auditUser_(ctx.user, before ? 'UPDATE' : 'CREATE', 'users', 'Users', record.user_id, before, record);
    return ok_({ user: publicUser_(record), temporaryPassword: temporaryPassword });
  } catch (err) { return errorResponse_(err); }
}

function apiSetUserStatus(token, userId, status) {
  try {
    var ctx = requirePermission_(token, 'users.manage');
    if (['ACTIVE', 'INACTIVE', 'SUSPENDED'].indexOf(status) < 0) return fail_('INVALID_STATUS', 'สถานะไม่ถูกต้อง');
    var user = findById_('Users', 'user_id', userId);
    if (!user) return fail_('NOT_FOUND', 'ไม่พบผู้ใช้');
    if (!ctx.isSuperAdmin && user.org_id !== ctx.orgId) throw appError_('TENANT_FORBIDDEN', 'ไม่สามารถจัดการผู้ใช้ต่างหน่วยงาน');
    updateRecordById_('Users', 'user_id', userId, { status: status, updated_at: nowIso_(), updated_by: ctx.user.user_id });
    if (status !== 'ACTIVE') revokeSessionsForUser_(userId);
    auditUser_(ctx.user, 'CHANGE_STATUS', 'users', 'Users', userId, { status: user.status }, { status: status });
    return ok_({ user_id: userId, status: status });
  } catch (err) { return errorResponse_(err); }
}

function apiResetUserPassword(token, userId, newPassword) {
  try {
    var ctx = requirePermission_(token, 'users.manage');
    var user = findById_('Users', 'user_id', userId);
    if (!user) return fail_('NOT_FOUND', 'ไม่พบผู้ใช้');
    if (!ctx.isSuperAdmin && user.org_id !== ctx.orgId) throw appError_('TENANT_FORBIDDEN', 'ไม่สามารถรีเซ็ตรหัสผ่านผู้ใช้ต่างหน่วยงาน');
    var password = String(newPassword || randomPassword_(18));
    if (password.length < 12) return fail_('WEAK_PASSWORD', 'รหัสผ่านต้องมีอย่างน้อย 12 ตัวอักษร');
    var salt = randomHex_(16);
    updateRecordById_('Users', 'user_id', userId, {
      password_salt: salt, password_hash: hashPassword_(password, salt),
      must_change_password: true, failed_login_count: 0, locked_until: '',
      updated_at: nowIso_(), updated_by: ctx.user.user_id
    });
    revokeSessionsForUser_(userId);
    auditUser_(ctx.user, 'RESET_PASSWORD', 'users', 'Users', userId, null, { must_change_password: true });
    return ok_({ temporaryPassword: password, mustChangePassword: true });
  } catch (err) { return errorResponse_(err); }
}

function apiListRoles(token, orgIdArg) {
  try {
    var ctx = requirePermission_(token, 'users.view');
    var orgId = resolveOrgScope_(ctx, orgIdArg);
    var rows = getRecords_('Roles').filter(function (r) {
      return r.status === 'ACTIVE' && (r.org_id === orgId || (ctx.isSuperAdmin && !orgId && !r.org_id));
    });
    return ok_({ items: rows.map(publicRole_) });
  } catch (err) { return errorResponse_(err); }
}

function apiSaveRole(token, payload) {
  try {
    var ctx = requirePermission_(token, 'roles.manage');
    payload = payload || {};
    var orgId = resolveOrgScope_(ctx, payload.org_id);
    requireOrganizationTarget_(orgId);
    var roleId = String(payload.role_id || '');
    var roleCode = safeText_(payload.role_code, 60).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    var roleName = safeText_(payload.role_name, 120);
    if (['SUPER_ADMIN', 'ORG_ADMIN', 'REGISTRAR', 'EXECUTIVE', 'DEPARTMENT_HEAD', 'STAFF', 'AUDITOR'].indexOf(roleCode) >= 0) return fail_('RESERVED_ROLE_CODE', 'รหัสบทบาทนี้เป็นรหัสมาตรฐานของระบบ');
    if (!roleCode || !roleName) return fail_('INVALID_INPUT', 'กรุณาระบุรหัสบทบาทและชื่อบทบาท');
    var before = roleId ? findById_('Roles', 'role_id', roleId) : null;
    if (roleId && !before) return fail_('NOT_FOUND', 'ไม่พบบทบาทที่ต้องการแก้ไข');
    if (before && before.org_id !== orgId) throw appError_('TENANT_FORBIDDEN', 'ไม่สามารถแก้ไขบทบาทต่างหน่วยงาน');
    if (before && before.is_system === true) return fail_('SYSTEM_ROLE_LOCKED', 'ไม่สามารถแก้ไขบทบาทระบบได้');
    var duplicate = findOne_('Roles', function (r) { return r.org_id === orgId && r.role_code === roleCode && r.role_id !== roleId; });
    if (duplicate) return fail_('DUPLICATE_ROLE', 'รหัสบทบาทนี้มีอยู่แล้ว');
    var record = {
      role_id: roleId || newId_(), org_id: orgId, role_code: roleCode,
      role_name: roleName, role_scope: 'ORGANIZATION',
      description: safeText_(payload.description, 500), is_system: false,
      status: payload.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
      updated_at: nowIso_()
    };
    if (before) updateRecordById_('Roles', 'role_id', roleId, record);
    else { record.created_at = nowIso_(); insertRecord_('Roles', record); }
    auditUser_(ctx.user, before ? 'UPDATE' : 'CREATE', 'roles', 'Roles', record.role_id, before, record);
    return ok_({ role: publicRole_(record) });
  } catch (err) { return errorResponse_(err); }
}

function apiSaveRolePermissions(token, roleId, permissionCodes) {
  try {
    var ctx = requirePermission_(token, 'roles.manage');
    var role = findById_('Roles', 'role_id', roleId);
    if (!role) return fail_('NOT_FOUND', 'ไม่พบบทบาท');
    if (!ctx.isSuperAdmin && role.org_id !== ctx.orgId) throw appError_('TENANT_FORBIDDEN', 'ไม่สามารถแก้ไขสิทธิ์ต่างหน่วยงาน');
    if (role.is_system === true) return fail_('SYSTEM_ROLE_LOCKED', 'ไม่สามารถแก้ไขสิทธิ์ของบทบาทระบบได้');
    if (!Array.isArray(permissionCodes)) return fail_('INVALID_INPUT', 'รูปแบบสิทธิ์ไม่ถูกต้อง');
    var known = {};
    getRecords_('Permissions').forEach(function (p) { known[p.permission_code] = true; });
    var selected = permissionCodes.filter(function (code) { return known[String(code)]; });
    var old = getRecords_('RolePermissions').filter(function (p) { return p.role_id === roleId; });
    old.forEach(function (p) { deleteRecordById_('RolePermissions', 'role_permission_id', p.role_permission_id); });
    selected.forEach(function (code) {
      insertRecord_('RolePermissions', {
        role_permission_id: newId_(), role_id: roleId, permission_code: code,
        is_allowed: true, created_at: nowIso_(), updated_at: nowIso_()
      });
    });
    auditUser_(ctx.user, 'UPDATE_PERMISSIONS', 'roles', 'Roles', roleId, { permissions: old.map(function (x) { return x.permission_code; }) }, { permissions: selected });
    return ok_({ role_id: roleId, permissions: selected });
  } catch (err) { return errorResponse_(err); }
}

function apiListDepartments(token, filters) {
  try {
    var ctx = requirePermission_(token, 'departments.view');
    filters = filters || {};
    var orgId = resolveOrgScope_(ctx, filters.org_id);
    var rows = getRecords_('Departments').filter(function (d) {
      return (ctx.isSuperAdmin && !filters.org_id ? true : d.org_id === orgId) &&
        (!filters.status || d.status === filters.status);
    });
    rows.sort(function (a, b) { return Number(a.sort_order || 0) - Number(b.sort_order || 0); });
    return ok_({ items: rows });
  } catch (err) { return errorResponse_(err); }
}

function apiSaveDepartment(token, payload) {
  try {
    var ctx = requirePermission_(token, 'departments.manage');
    payload = payload || {};
    var orgId = resolveOrgScope_(ctx, payload.org_id);
    requireOrganizationTarget_(orgId);
    var departmentId = String(payload.department_id || '');
    var name = safeText_(payload.department_name, 200);
    if (!name) return fail_('INVALID_INPUT', 'กรุณาระบุชื่อฝ่าย/กอง');
    var before = departmentId ? findById_('Departments', 'department_id', departmentId) : null;
    if (departmentId && !before) return fail_('NOT_FOUND', 'ไม่พบฝ่าย/กองที่ต้องการแก้ไข');
    if (before && before.org_id !== orgId) throw appError_('TENANT_FORBIDDEN', 'ไม่สามารถแก้ไขฝ่าย/กองต่างหน่วยงาน');
    var headId = String(payload.head_user_id || '');
    if (headId) {
      var head = findById_('Users', 'user_id', headId);
      if (!head || head.org_id !== orgId) return fail_('INVALID_USER', 'หัวหน้าฝ่าย/กองไม่ถูกต้อง');
    }
    var parentId = String(payload.parent_department_id || '');
    if (parentId) {
      var parent = findById_('Departments', 'department_id', parentId);
      if (!parent || parent.org_id !== orgId || parent.department_id === departmentId) return fail_('INVALID_PARENT', 'ฝ่าย/กองแม่ไม่ถูกต้อง');
    }
    var record = {
      department_id: departmentId || newId_(), org_id: orgId,
      department_code: safeText_(payload.department_code, 50), department_name: name,
      parent_department_id: parentId, head_user_id: headId,
      phone: safeText_(payload.phone, 50), email: safeText_(payload.email, 150),
      status: payload.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
      sort_order: Number(payload.sort_order || 0), updated_at: nowIso_()
    };
    if (before) updateRecordById_('Departments', 'department_id', departmentId, record);
    else { record.created_at = nowIso_(); insertRecord_('Departments', record); }
    auditUser_(ctx.user, before ? 'UPDATE' : 'CREATE', 'departments', 'Departments', record.department_id, before, record);
    return ok_({ department: record });
  } catch (err) { return errorResponse_(err); }
}

/* -------------------------------------------------------------------------- */
/* 07. LOOKUPS AND ORGANIZATION SETTINGS                                       */
/* -------------------------------------------------------------------------- */

function apiGetLookups(token, orgIdArg) {
  try {
    var ctx = requireSession_(token);
    var orgId = resolveOrgScope_(ctx, orgIdArg);
    function scoped(sheetName, idField) {
      return getRecords_(sheetName).filter(function (r) {
        return r.status === 'ACTIVE' && (r.org_id === orgId || (ctx.isSuperAdmin && !orgId));
      });
    }
    return ok_({
      bookTypes: scoped('BookTypes'), categories: scoped('BookCategories'),
      urgencyLevels: scoped('UrgencyLevels'), secrecyLevels: scoped('SecrecyLevels'),
      departments: getRecords_('Departments').filter(function (d) { return (ctx.isSuperAdmin && !orgId ? true : d.org_id === orgId) && d.status === 'ACTIVE'; }),
      users: getRecords_('Users').filter(function (u) { return (ctx.isSuperAdmin && !orgId ? true : u.org_id === orgId) && u.status === 'ACTIVE'; }).map(publicUser_),
      statuses: BOOK_STATUSES_
    });
  } catch (err) { return errorResponse_(err); }
}

function apiSaveLookup(token, lookupType, payload) {
  try {
    var ctx = requirePermission_(token, 'settings.manage');
    var config = {
      bookTypes: { sheet: 'BookTypes', id: 'book_type_id', code: 'type_code', name: 'type_name' },
      categories: { sheet: 'BookCategories', id: 'category_id', code: 'category_code', name: 'category_name' },
      urgencyLevels: { sheet: 'UrgencyLevels', id: 'urgency_id', code: 'urgency_code', name: 'urgency_name' },
      secrecyLevels: { sheet: 'SecrecyLevels', id: 'secrecy_id', code: 'secrecy_code', name: 'secrecy_name' }
    }[lookupType];
    if (!config) return fail_('INVALID_LOOKUP_TYPE', 'ประเภทข้อมูลไม่ถูกต้อง');
    payload = payload || {};
    var orgId = resolveOrgScope_(ctx, payload.org_id);
    requireOrganizationTarget_(orgId);
    var id = String(payload[config.id] || '');
    var before = id ? findById_(config.sheet, config.id, id) : null;
    if (id && !before) return fail_('NOT_FOUND', 'ไม่พบข้อมูลที่ต้องการแก้ไข');
    if (before && before.org_id !== orgId) throw appError_('TENANT_FORBIDDEN', 'ไม่สามารถแก้ไขข้อมูลต่างหน่วยงาน');
    var code = safeText_(payload[config.code], 60).toUpperCase();
    var name = safeText_(payload[config.name], 150);
    if (!code || !name) return fail_('INVALID_INPUT', 'กรุณาระบุรหัสและชื่อ');
    var duplicate = findOne_(config.sheet, function (r) { return r.org_id === orgId && r[config.code] === code && r[config.id] !== id; });
    if (duplicate) return fail_('DUPLICATE_CODE', 'รหัสนี้มีอยู่แล้ว');
    var record = {};
    record[config.id] = id || newId_();
    record.org_id = orgId;
    record[config.code] = code;
    record[config.name] = name;
    record.status = payload.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
    record.sort_order = Number(payload.sort_order || 0);
    record.description = safeText_(payload.description, 500);
    record.updated_at = nowIso_();
    if (lookupType === 'bookTypes') {
      record.direction_scope = payload.direction_scope || 'BOTH';
      record.is_system = before ? before.is_system : false;
    }
    if (lookupType === 'urgencyLevels') record.sla_days = Math.max(0, Number(payload.sla_days || 0));
    if (lookupType === 'secrecyLevels') record.access_policy = payload.access_policy || 'ORG';
    if (before && before.is_system === true) return fail_('SYSTEM_LOOKUP_LOCKED', 'ไม่สามารถแก้ไขข้อมูลมาตรฐานของระบบ');
    if (before) updateRecordById_(config.sheet, config.id, id, record);
    else { record.created_at = nowIso_(); insertRecord_(config.sheet, record); }
    auditUser_(ctx.user, before ? 'UPDATE' : 'CREATE', 'settings', config.sheet, record[config.id], before, record);
    return ok_({ item: record });
  } catch (err) { return errorResponse_(err); }
}

function apiGetSettings(token, orgIdArg) {
  try {
    var ctx = requireSession_(token);
    var orgId = resolveOrgScope_(ctx, orgIdArg);
    var rows = getRecords_('SystemSettings').filter(function (s) {
      return s.org_id === orgId && (ctx.isSuperAdmin || s.is_public === true || String(s.is_public) === 'true' || hasPermission_(ctx, 'settings.manage'));
    });
    var result = {};
    rows.forEach(function (s) { result[s.setting_key] = s.setting_value; });
    return ok_({ settings: result });
  } catch (err) { return errorResponse_(err); }
}

function apiSaveSettings(token, settingsObject) {
  try {
    var ctx = requirePermission_(token, 'settings.manage');
    settingsObject = settingsObject || {};
    var settingsOrgId = resolveOrgScope_(ctx, settingsObject.org_id);
    requireOrganizationTarget_(settingsOrgId);
    if (!settingsObject || typeof settingsObject !== 'object' || Array.isArray(settingsObject)) return fail_('INVALID_INPUT', 'ข้อมูลการตั้งค่าไม่ถูกต้อง');
    var allowedKeys = {
      fiscal_year_start_month: true, calendar_era_offset: true,
      registration_incoming_prefix: true, registration_outgoing_prefix: true,
      registration_digit_width: true, organization_timezone: true
    };
    var changed = [];
    Object.keys(settingsObject).forEach(function (key) {
      if (!allowedKeys[key]) return;
      var value = safeText_(settingsObject[key], 250);
      var row = findOne_('SystemSettings', function (s) { return s.org_id === settingsOrgId && s.setting_key === key; });
      if (row) updateRecordById_('SystemSettings', 'setting_id', row.setting_id, { setting_value: value, updated_at: nowIso_(), updated_by: ctx.user.user_id });
      else insertRecord_('SystemSettings', {
        setting_id: newId_(), org_id: settingsOrgId, setting_key: key, setting_value: value,
        value_type: 'string', description: '', is_public: true,
        updated_at: nowIso_(), updated_by: ctx.user.user_id
      });
      changed.push(key);
    });
    auditUser_(ctx.user, 'UPDATE_SETTINGS', 'settings', 'SystemSettings', settingsOrgId, null, { keys: changed });
    return ok_({ updated: changed });
  } catch (err) { return errorResponse_(err); }
}

/* -------------------------------------------------------------------------- */
/* 08. INCOMING / OUTGOING BOOK REGISTERS                                      */
/* -------------------------------------------------------------------------- */

function apiListBooks(token, direction, filters) {
  try {
    var sheetName = direction === 'OUTGOING' ? 'OutgoingBooks' : 'IncomingBooks';
    var permission = direction === 'OUTGOING' ? 'books.outgoing.view' : 'books.incoming.view';
    var ctx = requirePermission_(token, permission);
    filters = filters || {};
    var orgId = resolveOrgScope_(ctx, filters.org_id);
    var idField = direction === 'OUTGOING' ? 'outgoing_id' : 'incoming_id';
    var q = String(filters.search || '').toLowerCase();
    var status = String(filters.status || '');
    var departmentId = String(filters.department_id || '');
    var dateFrom = filters.date_from ? new Date(filters.date_from).getTime() : null;
    var dateTo = filters.date_to ? new Date(filters.date_to).getTime() : null;
    var rows = getRecords_(sheetName).filter(function (r) {
      if (ctx.isSuperAdmin && !filters.org_id) {
        // ส่วนกลางสามารถดูข้ามหน่วยงานได้เมื่อเลือกเมนูภาพรวม/รายงานเท่านั้น
      } else if (r.org_id !== orgId) return false;
      if (r.deleted_at) return false;
      if (status && r.status !== status && r.sent_status !== status) return false;
      if (departmentId && r.assigned_department_id !== departmentId) return false;
      if (!canViewBookRecord_(ctx, r, direction)) return false;
      var dateValue = direction === 'OUTGOING' ? r.send_date || r.register_date : r.receive_date;
      var dateMs = dateValue ? new Date(dateValue).getTime() : 0;
      if (dateFrom && dateMs < dateFrom) return false;
      if (dateTo && dateMs > dateTo + 86399999) return false;
      if (q) {
        var text = [r.registration_no, r.letter_no, r.subject, r.sender_org_name, r.recipient_org_name,
          r.sender_person_name, r.recipient_person_name, r.addressed_to].join(' ').toLowerCase();
        if (text.indexOf(q) < 0) return false;
      }
      return true;
    });
    rows.sort(function (a, b) {
      return new Date(b.created_at || b.receive_date || b.send_date || 0).getTime() - new Date(a.created_at || a.receive_date || a.send_date || 0).getTime();
    });
    var total = rows.length;
    var page = Math.max(1, Number(filters.page || 1));
    var pageSize = Math.min(APP_.MAX_PAGE_SIZE, Math.max(1, Number(filters.pageSize || APP_.DEFAULT_PAGE_SIZE)));
    var start = (page - 1) * pageSize;
    return ok_({ items: rows.slice(start, start + pageSize), total: total, page: page, pageSize: pageSize, pages: Math.ceil(total / pageSize) });
  } catch (err) { return errorResponse_(err); }
}

function apiGetBook(token, direction, bookId) {
  try {
    var isOutgoing = direction === 'OUTGOING';
    var permission = isOutgoing ? 'books.outgoing.view' : 'books.incoming.view';
    var ctx = requirePermission_(token, permission);
    var sheetName = isOutgoing ? 'OutgoingBooks' : 'IncomingBooks';
    var idField = isOutgoing ? 'outgoing_id' : 'incoming_id';
    var book = findById_(sheetName, idField, bookId);
    if (!book || book.deleted_at) return fail_('NOT_FOUND', 'ไม่พบหนังสือ');
    assertTenantAccess_(ctx, book.org_id);
    if (!canViewBookRecord_(ctx, book, isOutgoing ? 'OUTGOING' : 'INCOMING')) throw appError_('FORBIDDEN', 'คุณไม่มีสิทธิ์ดูหนังสือรายการนี้');
    var assignments = getRecords_('BookAssignments').filter(function (x) { return x.org_id === book.org_id && x.book_direction === direction && x.book_id === bookId; });
    var actions = getRecords_('BookActions').filter(function (x) { return x.org_id === book.org_id && x.book_direction === direction && x.book_id === bookId; });
    var attachments = getRecords_('BookAttachments').filter(function (x) { return x.org_id === book.org_id && x.book_direction === direction && x.book_id === bookId && x.status === 'ACTIVE'; });
    actions.sort(function (a, b) { return new Date(a.action_at).getTime() - new Date(b.action_at).getTime(); });
    assignments.sort(function (a, b) { return new Date(a.assigned_at).getTime() - new Date(b.assigned_at).getTime(); });
    return ok_({ book: book, assignments: assignments, actions: actions, attachments: attachments.map(publicAttachment_) });
  } catch (err) { return errorResponse_(err); }
}

function apiSaveIncomingBook(token, payload) {
  return saveBook_(token, 'INCOMING', payload);
}

function apiSaveOutgoingBook(token, payload) {
  return saveBook_(token, 'OUTGOING', payload);
}

function saveBook_(token, direction, payload) {
  try {
    payload = payload || {};
    var outgoing = direction === 'OUTGOING';
    var prefix = outgoing ? 'books.outgoing.' : 'books.incoming.';
    var bookId = String(payload[outgoing ? 'outgoing_id' : 'incoming_id'] || '');
    var ctx = requirePermission_(token, prefix + (bookId ? 'update' : 'create'));
    var orgId = resolveOrgScope_(ctx, payload.org_id);
    requireOrganizationTarget_(orgId);
    var sheetName = outgoing ? 'OutgoingBooks' : 'IncomingBooks';
    var idField = outgoing ? 'outgoing_id' : 'incoming_id';
    var before = bookId ? findById_(sheetName, idField, bookId) : null;
    if (bookId && !before) return fail_('NOT_FOUND', 'ไม่พบหนังสือที่ต้องการแก้ไข');
    if (before && before.org_id !== orgId) throw appError_('TENANT_FORBIDDEN', 'ไม่สามารถแก้ไขหนังสือต่างหน่วยงาน');
    var subject = safeText_(payload.subject, 1000);
    if (!subject) return fail_('INVALID_INPUT', 'กรุณาระบุเรื่องหนังสือ');
    var now = nowIso_();
    var record = {};
    record[idField] = bookId || newId_();
    record.org_id = orgId;
    record.subject = subject;
    record.summary = safeText_(payload.summary, 5000);
    record.letter_no = safeText_(payload.letter_no, 120);
    record.letter_date = normalizeDateString_(payload.letter_date);
    record.book_type_id = String(payload.book_type_id || '');
    record.category_id = String(payload.category_id || '');
    record.urgency_id = String(payload.urgency_id || '');
    record.secrecy_id = String(payload.secrecy_id || '');
    record.addressed_to = safeText_(payload.addressed_to, 250);
    record.remarks = safeText_(payload.remarks, 3000);
    record.status = before ? before.status : 'เข้าใหม่';
    record.updated_at = now;
    record.updated_by = ctx.user.user_id;

    if (outgoing) {
      record.register_date = normalizeDateString_(payload.register_date) || todayString_();
      record.send_date = normalizeDateString_(payload.send_date);
      record.send_time = safeText_(payload.send_time, 20);
      record.recipient_org_name = safeText_(payload.recipient_org_name, 250);
      record.recipient_person_name = safeText_(payload.recipient_person_name, 200);
      record.recipient_address = safeText_(payload.recipient_address, 1000);
      record.recipient_email = safeText_(payload.recipient_email, 150);
      record.recipient_phone = safeText_(payload.recipient_phone, 50);
      record.signatory_user_id = String(payload.signatory_user_id || '');
      record.send_method = safeText_(payload.send_method, 80);
      record.tracking_no = safeText_(payload.tracking_no, 120);
      record.dispatched_at = normalizeDateString_(payload.dispatched_at);
      record.sent_status = safeText_(payload.sent_status, 80) || 'PENDING';
      record.assigned_department_id = String(payload.assigned_department_id || '');
    } else {
      record.receive_date = normalizeDateString_(payload.receive_date) || todayString_();
      record.receive_time = safeText_(payload.receive_time, 20);
      record.sender_org_name = safeText_(payload.sender_org_name, 250);
      record.sender_person_name = safeText_(payload.sender_person_name, 200);
      record.sender_contact = safeText_(payload.sender_contact, 200);
      record.assigned_department_id = String(payload.assigned_department_id || '');
      record.assigned_user_id = String(payload.assigned_user_id || '');
      record.received_by_user_id = before ? before.received_by_user_id : ctx.user.user_id;
      record.due_date = normalizeDateString_(payload.due_date);
    }
    if (record.assigned_department_id) {
      var dep = findById_('Departments', 'department_id', record.assigned_department_id);
      if (!dep || dep.org_id !== orgId) return fail_('INVALID_DEPARTMENT', 'ฝ่าย/กองที่ระบุไม่ถูกต้อง');
    }
    if (!before) {
      var sequence = getNextRegistrationNumber_(orgId, direction, outgoing ? record.register_date : record.receive_date, ctx.user.user_id);
      record.fiscal_year = sequence.fiscalYear;
      record.registration_seq = sequence.number;
      record.registration_no = sequence.registrationNo;
      record.created_at = now;
      record.created_by = ctx.user.user_id;
      if (outgoing) record.sent_status = record.sent_status || 'PENDING';
      insertRecord_(sheetName, record);
      appendBookAction_(orgId, direction, record[idField], 'REGISTERED', 'ลงทะเบียนหนังสือ', 'สร้างรายการทะเบียน ' + record.registration_no, '', record.status, ctx.user, '');
    } else {
      updateRecordById_(sheetName, idField, bookId, record);
      appendBookAction_(orgId, direction, bookId, 'UPDATED', 'แก้ไขข้อมูลหนังสือ', 'ปรับปรุงข้อมูลทะเบียน', before.status, record.status, ctx.user, '');
    }
    auditUser_(ctx.user, before ? 'UPDATE' : 'CREATE', outgoing ? 'outgoing' : 'incoming', sheetName, record[idField], before, record);
    return ok_({ book: record, created: !before });
  } catch (err) { return errorResponse_(err); }
}

function getNextRegistrationNumber_(orgId, direction, dateString, userId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var settings = getSettingsMap_(orgId);
    var startMonth = Math.min(12, Math.max(1, Number(settings.fiscal_year_start_month || 10)));
    var offset = Number(settings.calendar_era_offset || 543);
    var date = dateString ? new Date(dateString + 'T00:00:00') : new Date();
    if (isNaN(date.getTime())) date = new Date();
    var fiscalYear = date.getFullYear() + offset + (date.getMonth() + 1 >= startMonth ? 1 : 0);
    var directionName = direction === 'OUTGOING' ? 'OUTGOING' : 'INCOMING';
    var seq = findOne_('NumberSequences', function (r) {
      return r.org_id === orgId && r.book_direction === directionName && Number(r.fiscal_year) === fiscalYear;
    });
    var nextNumber = seq ? Number(seq.last_number || 0) + 1 : 1;
    var prefix = seq ? String(seq.prefix || '') : String(settings[direction === 'OUTGOING' ? 'registration_outgoing_prefix' : 'registration_incoming_prefix'] || (direction === 'OUTGOING' ? 'ส่ง' : 'รับ'));
    var width = seq ? Number(seq.digit_width || 4) : Number(settings.registration_digit_width || 4);
    var formatted = String(nextNumber).padStart(width, '0');
    var pattern = seq && seq.number_pattern ? String(seq.number_pattern) : '{PREFIX}/{FY}/{SEQ}';
    var registrationNo = pattern.replace('{PREFIX}', prefix).replace('{FY}', String(fiscalYear)).replace('{SEQ}', formatted);
    if (seq) {
      updateRecordById_('NumberSequences', 'sequence_id', seq.sequence_id, {
        last_number: nextNumber, updated_at: nowIso_(), updated_by: userId
      });
    } else {
      insertRecord_('NumberSequences', {
        sequence_id: newId_(), org_id: orgId, book_direction: directionName,
        fiscal_year: fiscalYear, prefix: prefix, last_number: nextNumber,
        digit_width: width, number_pattern: pattern, reset_rule: 'FISCAL_YEAR',
        updated_at: nowIso_(), updated_by: userId
      });
    }
    return { fiscalYear: fiscalYear, number: nextNumber, registrationNo: registrationNo };
  } finally {
    lock.releaseLock();
  }
}


function apiDeleteBook(token, direction, bookId) {
  try {
    var outgoing = direction === 'OUTGOING';
    var permission = outgoing ? 'books.outgoing.delete' : 'books.incoming.delete';
    var ctx = requirePermission_(token, permission);
    var sheetName = outgoing ? 'OutgoingBooks' : 'IncomingBooks';
    var idField = outgoing ? 'outgoing_id' : 'incoming_id';
    var book = findById_(sheetName, idField, bookId);
    if (!book || book.deleted_at) return fail_('NOT_FOUND', 'ไม่พบหนังสือ');
    assertTenantAccess_(ctx, book.org_id);
    updateRecordById_(sheetName, idField, bookId, {
      deleted_at: nowIso_(), deleted_by: ctx.user.user_id,
      status: 'ยกเลิก', updated_at: nowIso_(), updated_by: ctx.user.user_id
    });
    appendBookAction_(book.org_id, outgoing ? 'OUTGOING' : 'INCOMING', bookId, 'CANCELLED', 'ยกเลิกรายการทะเบียน', '', book.status, 'ยกเลิก', ctx.user, '');
    auditUser_(ctx.user, 'SOFT_DELETE', outgoing ? 'outgoing' : 'incoming', sheetName, bookId, { status: book.status }, { status: 'ยกเลิก', deleted_at: nowIso_() });
    return ok_({ deleted: true, book_id: bookId });
  } catch (err) { return errorResponse_(err); }
}

/* -------------------------------------------------------------------------- */
/* 09. WORKFLOW: ASSIGNMENTS, ACTIONS AND STATUS                               */
/* -------------------------------------------------------------------------- */

function apiAssignBook(token, payload) {
  try {
    var ctx = requirePermission_(token, 'workflow.assign');
    payload = payload || {};
    var direction = payload.book_direction === 'OUTGOING' ? 'OUTGOING' : 'INCOMING';
    var bookId = String(payload.book_id || '');
    var orgId = resolveOrgScope_(ctx, payload.org_id);
    requireOrganizationTarget_(orgId);
    var book = getBookRecord_(direction, bookId);
    if (!book || book.org_id !== orgId || book.deleted_at) return fail_('NOT_FOUND', 'ไม่พบหนังสือในหน่วยงานนี้');
    var toUserId = String(payload.to_user_id || '');
    var toDepartmentId = String(payload.to_department_id || '');
    if (!toUserId && !toDepartmentId) return fail_('INVALID_INPUT', 'กรุณาเลือกผู้รับผิดชอบหรือฝ่าย/กอง');
    if (toUserId) {
      var user = findById_('Users', 'user_id', toUserId);
      if (!user || user.org_id !== orgId || user.status !== 'ACTIVE') return fail_('INVALID_USER', 'ผู้รับผิดชอบไม่ถูกต้อง');
    }
    if (toDepartmentId) {
      var department = findById_('Departments', 'department_id', toDepartmentId);
      if (!department || department.org_id !== orgId) return fail_('INVALID_DEPARTMENT', 'ฝ่าย/กองไม่ถูกต้อง');
    }
    var assignment = {
      assignment_id: newId_(), org_id: orgId, book_direction: direction,
      book_id: bookId, from_user_id: ctx.user.user_id, to_user_id: toUserId,
      to_department_id: toDepartmentId, assigned_at: nowIso_(),
      due_date: normalizeDateString_(payload.due_date),
      instruction: safeText_(payload.instruction, 2000), status: 'ASSIGNED',
      completed_at: '', completion_note: '', created_by: ctx.user.user_id,
      created_at: nowIso_(), updated_at: nowIso_()
    };
    insertRecord_('BookAssignments', assignment);
    var sheetName = direction === 'OUTGOING' ? 'OutgoingBooks' : 'IncomingBooks';
    var idField = direction === 'OUTGOING' ? 'outgoing_id' : 'incoming_id';
    var newStatus = 'ดำเนินการ';
    updateRecordById_(sheetName, idField, bookId, {
      status: newStatus,
      assigned_department_id: toDepartmentId || book.assigned_department_id || '',
      ...(direction === 'INCOMING' ? { assigned_user_id: toUserId || book.assigned_user_id || '', due_date: assignment.due_date || book.due_date } : {}),
      updated_at: nowIso_(), updated_by: ctx.user.user_id
    });
    appendBookAction_(orgId, direction, bookId, 'ASSIGNED', 'มอบหมายงาน', assignment.instruction, book.status, newStatus, ctx.user, '');
    if (toUserId) createNotification_(orgId, toUserId, 'BOOK_ASSIGNED', 'มีหนังสือมอบหมายใหม่', book.subject, direction, bookId);
    if (toDepartmentId) {
      var deptUsers = getRecords_('Users').filter(function (u) { return u.org_id === orgId && u.department_id === toDepartmentId && u.status === 'ACTIVE'; });
      deptUsers.forEach(function (u) { createNotification_(orgId, u.user_id, 'BOOK_ASSIGNED', 'มีหนังสือมอบหมายให้ฝ่าย/กอง', book.subject, direction, bookId); });
    }
    auditUser_(ctx.user, 'ASSIGN', 'workflow', 'BookAssignments', assignment.assignment_id, null, assignment);
    return ok_({ assignment: assignment, status: newStatus });
  } catch (err) { return errorResponse_(err); }
}

function apiAddBookAction(token, payload) {
  try {
    var ctx = requirePermission_(token, 'workflow.action');
    payload = payload || {};
    var direction = payload.book_direction === 'OUTGOING' ? 'OUTGOING' : 'INCOMING';
    var bookId = String(payload.book_id || '');
    var orgId = resolveOrgScope_(ctx, payload.org_id);
    requireOrganizationTarget_(orgId);
    var book = getBookRecord_(direction, bookId);
    if (!book || book.org_id !== orgId) return fail_('NOT_FOUND', 'ไม่พบหนังสือ');
    var actionTitle = safeText_(payload.action_title, 200);
    if (!actionTitle) return fail_('INVALID_INPUT', 'กรุณาระบุหัวข้อการดำเนินการ');
    var newStatus = String(payload.new_status || book.status);
    if (BOOK_STATUSES_.indexOf(newStatus) < 0) return fail_('INVALID_STATUS', 'สถานะหนังสือไม่ถูกต้อง');
    var actionId = appendBookAction_(orgId, direction, bookId,
      safeText_(payload.action_type, 80) || 'COMMENT', actionTitle,
      safeText_(payload.action_detail, 5000), book.status, newStatus, ctx.user,
      String(payload.attachment_id || ''));
    if (newStatus !== book.status) {
      var sheetName = direction === 'OUTGOING' ? 'OutgoingBooks' : 'IncomingBooks';
      var idField = direction === 'OUTGOING' ? 'outgoing_id' : 'incoming_id';
      updateRecordById_(sheetName, idField, bookId, { status: newStatus, updated_at: nowIso_(), updated_by: ctx.user.user_id });
    }
    auditUser_(ctx.user, 'BOOK_ACTION', 'workflow', 'BookActions', actionId, { status: book.status }, { status: newStatus, action_title: actionTitle });
    return ok_({ action_id: actionId, status: newStatus });
  } catch (err) { return errorResponse_(err); }
}

function apiCompleteAssignment(token, payload) {
  try {
    var ctx = requirePermission_(token, 'workflow.complete');
    payload = payload || {};
    var assignmentId = String(payload.assignment_id || '');
    var assignment = findById_('BookAssignments', 'assignment_id', assignmentId);
    if (!assignment) return fail_('NOT_FOUND', 'ไม่พบรายการมอบหมาย');
    assertTenantAccess_(ctx, assignment.org_id);
    var isAssignedUser = assignment.to_user_id && assignment.to_user_id === ctx.user.user_id;
    var isAssignedDepartment = assignment.to_department_id && assignment.to_department_id === ctx.user.department_id;
    if (!ctx.isSuperAdmin && !isAssignedUser && !isAssignedDepartment && !hasPermission_(ctx, 'workflow.assign')) {
      throw appError_('FORBIDDEN', 'ไม่มีสิทธิ์ปิดงานมอบหมายนี้');
    }
    updateRecordById_('BookAssignments', 'assignment_id', assignmentId, {
      status: 'COMPLETED', completed_at: nowIso_(), completion_note: safeText_(payload.completion_note, 3000), updated_at: nowIso_()
    });
    var direction = assignment.book_direction;
    appendBookAction_(assignment.org_id, direction, assignment.book_id, 'COMPLETED', 'ดำเนินการเสร็จสิ้น', safeText_(payload.completion_note, 3000), '', 'ดำเนินการแล้ว', ctx.user, '');
    var sheetName = direction === 'OUTGOING' ? 'OutgoingBooks' : 'IncomingBooks';
    var idField = direction === 'OUTGOING' ? 'outgoing_id' : 'incoming_id';
    updateRecordById_(sheetName, idField, assignment.book_id, { status: 'ดำเนินการแล้ว', updated_at: nowIso_(), updated_by: ctx.user.user_id });
    auditUser_(ctx.user, 'COMPLETE_ASSIGNMENT', 'workflow', 'BookAssignments', assignmentId, assignment, { status: 'COMPLETED' });
    return ok_({ completed: true });
  } catch (err) { return errorResponse_(err); }
}

/* -------------------------------------------------------------------------- */
/* 10. DASHBOARD, REPORTS, NOTIFICATIONS AND AUDIT                             */
/* -------------------------------------------------------------------------- */

function apiGetDashboardSummary(token, filters) {
  try {
    var ctx = requirePermission_(token, 'dashboard.view');
    filters = filters || {};
    var orgId = resolveOrgScope_(ctx, filters.org_id);
    var allowAll = ctx.isSuperAdmin && !filters.org_id;
    function inScope(row) { return allowAll || row.org_id === orgId; }
    var incoming = getRecords_('IncomingBooks').filter(function (r) { return inScope(r) && !r.deleted_at && canViewBookRecord_(ctx, r, 'INCOMING'); });
    var outgoing = getRecords_('OutgoingBooks').filter(function (r) { return inScope(r) && !r.deleted_at && canViewBookRecord_(ctx, r, 'OUTGOING'); });
    var today = todayString_();
    var openStatuses = ['เข้าใหม่', 'รอเสนอ', 'รอมอบหมาย', 'ดำเนินการ', 'รอตอบกลับ', 'เกินกำหนด'];
    var pendingIncoming = incoming.filter(function (r) { return openStatuses.indexOf(r.status) >= 0; });
    var overdue = incoming.filter(function (r) { return r.due_date && r.due_date < today && r.status !== 'ดำเนินการแล้ว' && r.status !== 'ยกเลิก'; });
    var byStatus = {};
    incoming.concat(outgoing).forEach(function (r) { byStatus[r.status || 'ไม่ระบุ'] = (byStatus[r.status || 'ไม่ระบุ'] || 0) + 1; });
    var unread = getRecords_('Notifications').filter(function (n) { return n.recipient_user_id === ctx.user.user_id && !truthy_(n.is_read); }).length;
    var orgCount = ctx.isSuperAdmin ? getRecords_('Organizations').filter(function (o) { return o.status === 'ACTIVE'; }).length : 1;
    return ok_({
      organizationCount: orgCount,
      incomingCount: incoming.length,
      outgoingCount: outgoing.length,
      pendingCount: pendingIncoming.length,
      overdueCount: overdue.length,
      unreadNotificationCount: unread,
      byStatus: byStatus,
      recentIncoming: incoming.sort(sortNewest_).slice(0, 8),
      recentOutgoing: outgoing.sort(sortNewest_).slice(0, 8)
    });
  } catch (err) { return errorResponse_(err); }
}

function apiGetReportData(token, filters) {
  try {
    var ctx = requirePermission_(token, 'reports.view');
    filters = filters || {};
    if (filters.export === true) requirePermission_(token, 'reports.export');
    var direction = filters.direction === 'OUTGOING' ? 'OUTGOING' : (filters.direction === 'INCOMING' ? 'INCOMING' : 'BOTH');
    var orgId = resolveOrgScope_(ctx, filters.org_id);
    var allowAll = ctx.isSuperAdmin && !filters.org_id;
    var from = filters.date_from ? new Date(filters.date_from).getTime() : null;
    var to = filters.date_to ? new Date(filters.date_to).getTime() + 86399999 : null;
    function filterRows(rows, outgoing) {
      return rows.filter(function (r) {
        if (!(allowAll || r.org_id === orgId) || r.deleted_at || !canViewBookRecord_(ctx, r, outgoing ? 'OUTGOING' : 'INCOMING')) return false;
        var date = outgoing ? (r.send_date || r.register_date) : r.receive_date;
        var ms = date ? new Date(date).getTime() : 0;
        if (from && ms < from) return false;
        if (to && ms > to) return false;
        if (filters.status && r.status !== filters.status) return false;
        if (filters.department_id && r.assigned_department_id !== filters.department_id) return false;
        if (filters.fiscal_year && Number(r.fiscal_year) !== Number(filters.fiscal_year)) return false;
        return true;
      });
    }
    var incoming = direction === 'OUTGOING' ? [] : filterRows(getRecords_('IncomingBooks'), false);
    var outgoing = direction === 'INCOMING' ? [] : filterRows(getRecords_('OutgoingBooks'), true);
    var items = incoming.map(function (r) { return Object.assign({ book_direction: 'INCOMING' }, r); })
      .concat(outgoing.map(function (r) { return Object.assign({ book_direction: 'OUTGOING' }, r); }));
    items.sort(sortNewest_);
    if (items.length > APP_.MAX_REPORT_ROWS) throw appError_('REPORT_TOO_LARGE', 'รายงานมีข้อมูลเกินขีดจำกัดต่อคำขอ กรุณาจำกัดช่วงวันที่หรือแบ่งรายงาน');
    var reportId = newId_();
    insertRecord_('ReportLogs', {
      report_id: reportId, org_id: allowAll ? '' : orgId,
      report_type: 'REGISTER_REPORT', filters_json: JSON.stringify(safeAuditObject_(filters)),
      file_name: '', generated_by: ctx.user.user_id, generated_at: nowIso_(),
      record_count: items.length, status: 'DATA_READY'
    });
    auditUser_(ctx.user, 'GENERATE_REPORT_DATA', 'reports', 'ReportLogs', reportId, null, { record_count: items.length });
    return ok_({ items: items, total: items.length, reportId: reportId, generatedAt: nowIso_(), message: items.length ? '' : 'ไม่พบข้อมูลตามเงื่อนไขที่เลือก' });
  } catch (err) { return errorResponse_(err); }
}

function apiListNotifications(token, filters) {
  try {
    var ctx = requireSession_(token);
    filters = filters || {};
    var rows = getRecords_('Notifications').filter(function (n) {
      return n.org_id === ctx.orgId && n.recipient_user_id === ctx.user.user_id &&
        (!filters.unreadOnly || !truthy_(n.is_read));
    });
    rows.sort(function (a, b) { return new Date(b.created_at).getTime() - new Date(a.created_at).getTime(); });
    return ok_({ items: rows.slice(0, Math.min(100, Number(filters.limit || 50))), total: rows.length });
  } catch (err) { return errorResponse_(err); }
}

function apiMarkNotificationRead(token, notificationId, markAll) {
  try {
    var ctx = requireSession_(token);
    var rows = getRecords_('Notifications').filter(function (n) {
      return n.org_id === ctx.orgId && n.recipient_user_id === ctx.user.user_id &&
        (markAll === true || n.notification_id === notificationId);
    });
    rows.forEach(function (n) { updateRecordById_('Notifications', 'notification_id', n.notification_id, { is_read: true, read_at: nowIso_() }); });
    return ok_({ updated: rows.length });
  } catch (err) { return errorResponse_(err); }
}

function apiListAuditLogs(token, filters) {
  try {
    var ctx = requirePermission_(token, 'audit.view');
    filters = filters || {};
    var orgId = resolveOrgScope_(ctx, filters.org_id);
    var rows = getRecords_('AuditLogs').filter(function (r) {
      return (ctx.isSuperAdmin && !filters.org_id ? true : r.org_id === orgId) &&
        (!filters.module_key || r.module_key === filters.module_key) &&
        (!filters.actor_user_id || r.actor_user_id === filters.actor_user_id);
    });
    rows.sort(function (a, b) { return new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(); });
    var limit = Math.min(500, Math.max(1, Number(filters.limit || 100)));
    return ok_({ items: rows.slice(0, limit), total: rows.length });
  } catch (err) { return errorResponse_(err); }
}

/* -------------------------------------------------------------------------- */
/* 11. IMAGE UPLOAD: IMGBB (IMAGES ONLY)                                       */
/* -------------------------------------------------------------------------- */

function apiUploadImageToImgBB(token, payload) {
  try {
    var ctx = requirePermission_(token, 'files.upload');
    payload = payload || {};
    var apiKey = PropertiesService.getScriptProperties().getProperty('IMGBB_API_KEY');
    if (!apiKey) throw appError_('IMGBB_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่า IMGBB_API_KEY ใน Script Properties');
    var base64 = String(payload.base64Data || '').replace(/^data:[^,]+,/, '').replace(/\s/g, '');
    if (!base64 || base64.length > 8 * 1024 * 1024) return fail_('INVALID_IMAGE', 'ไม่พบรูปภาพหรือรูปภาพมีขนาดใหญ่เกินกำหนด');
    var response = UrlFetchApp.fetch('https://api.imgbb.com/1/upload?key=' + encodeURIComponent(apiKey), {
      method: 'post', payload: { image: base64, name: safeText_(payload.fileName, 150) || 'image' },
      muteHttpExceptions: true
    });
    var status = response.getResponseCode();
    var body = JSON.parse(response.getContentText() || '{}');
    if (status < 200 || status >= 300 || !body.success || !body.data || !body.data.url) {
      throw appError_('IMGBB_UPLOAD_FAILED', 'อัปโหลดรูปภาพไป ImgBB ไม่สำเร็จ');
    }
    var imageUrl = safeHttpsUrl_(body.data.url);
    auditUser_(ctx.user, 'UPLOAD_IMAGE', 'files', 'Image', '', null, { file_name: safeText_(payload.fileName, 150) });
    return ok_({ url: imageUrl, deleteUrl: '', imageId: body.data.id || '' });
  } catch (err) { return errorResponse_(err); }
}

/* -------------------------------------------------------------------------- */
/* 12. PRIVATE FILE STORAGE AND PASSWORD-PROTECTED DOWNLOAD                    */
/* -------------------------------------------------------------------------- */

function apiUploadPrivateFile(token, payload) {
  try {
    var ctx = requirePermission_(token, 'files.upload');
    payload = payload || {};
    var direction = payload.book_direction === 'OUTGOING' ? 'OUTGOING' : 'INCOMING';
    var bookId = String(payload.book_id || '');
    var book = getBookRecord_(direction, bookId);
    if (!book) return fail_('NOT_FOUND', 'ไม่พบหนังสือที่จะเพิ่มเอกสารแนบ');
    assertTenantAccess_(ctx, book.org_id);
    if (!canViewBookRecord_(ctx, book, direction)) throw appError_('FORBIDDEN', 'ไม่มีสิทธิ์แนบไฟล์กับหนังสือรายการนี้');
    var fileName = safeFileName_(payload.fileName || 'attachment');
    var mimeType = safeText_(payload.mimeType, 150) || 'application/octet-stream';
    var base64 = String(payload.base64Data || '').replace(/^data:[^,]+,/, '').replace(/\s/g, '');
    if (!base64) return fail_('INVALID_FILE', 'ไม่พบข้อมูลไฟล์');
    var estimatedBytes = Math.floor(base64.length * 3 / 4);
    var maxBytes = Number(PropertiesService.getScriptProperties().getProperty('FILE_MAX_UPLOAD_BYTES') || APP_.MAX_UPLOAD_BYTES_DEFAULT);
    if (estimatedBytes > maxBytes) return fail_('FILE_TOO_LARGE', 'ไฟล์มีขนาดเกินกว่าที่ระบบกำหนด');
    var storageProvider = getStorageProvider_();
    var folder = 'organizations/' + String(book.org_id) + '/' + direction.toLowerCase();
    var storageResponse = callR2Service_('POST', '/upload', {
      fileName: fileName,
      mimeType: mimeType,
      base64Data: base64,
      folder: folder
    });
    var storageKey = String(storageResponse.key || storageResponse.storage_key || storageResponse.objectKey || '');
    if (!storageKey) throw appError_('FILE_SERVICE_INVALID_RESPONSE', 'Cloudflare Worker ไม่ส่ง key ของไฟล์กลับมา');
    var attachmentId = newId_();
    var attachment = {
      attachment_id: attachmentId, org_id: book.org_id, book_direction: direction,
      book_id: bookId, file_category: safeText_(payload.fileCategory, 80) || 'DOCUMENT',
      file_name: safeFileName_(storageResponse.fileName || storageResponse.file_name || fileName),
      original_file_name: fileName, mime_type: safeText_(storageResponse.mimeType || storageResponse.mime_type || mimeType, 150),
      file_extension: getFileExtension_(fileName),
      file_size_bytes: Number(storageResponse.size || storageResponse.fileSize || storageResponse.file_size_bytes || estimatedBytes),
      storage_provider: storageProvider, storage_key: storageKey,
      file_url: '', thumbnail_url: '',
      is_primary: payload.isPrimary === true, access_level: 'PRIVATE',
      uploaded_by: ctx.user.user_id, uploaded_at: nowIso_(), status: 'ACTIVE'
    };
    insertRecord_('BookAttachments', attachment);
    if (attachment.is_primary) {
      var sheetName = direction === 'OUTGOING' ? 'OutgoingBooks' : 'IncomingBooks';
      var idField = direction === 'OUTGOING' ? 'outgoing_id' : 'incoming_id';
      updateRecordById_(sheetName, idField, bookId, { primary_attachment_id: attachmentId, updated_at: nowIso_(), updated_by: ctx.user.user_id });
    }
    auditUser_(ctx.user, 'UPLOAD_PRIVATE_FILE', 'files', 'BookAttachments', attachmentId, null, {
      book_id: bookId, file_name: fileName, file_size_bytes: attachment.file_size_bytes
    });
    return ok_({ attachment: publicAttachment_(attachment) });
  } catch (err) { return errorResponse_(err); }
}

function apiPrepareFileDownload(token, attachmentId, userAgent) {
  try {
    var ctx = requirePermission_(token, 'files.download');
    var attachment = findById_('BookAttachments', 'attachment_id', attachmentId);
    if (!attachment || attachment.status !== 'ACTIVE') return fail_('NOT_FOUND', 'ไม่พบไฟล์หรือไฟล์ถูกปิดใช้งาน');
    assertTenantAccess_(ctx, attachment.org_id);
    var book = getBookRecord_(attachment.book_direction, attachment.book_id);
    if (!book || book.org_id !== attachment.org_id) return fail_('NOT_FOUND', 'ไม่พบเอกสารต้นทาง');
    if (!canViewBookRecord_(ctx, book, attachment.book_direction)) throw appError_('FORBIDDEN', 'คุณไม่มีสิทธิ์เข้าถึงหนังสือที่แนบไฟล์นี้');
    enforceSecrecyAccess_(ctx, book);
    if (!attachment.storage_key || !attachment.storage_provider) throw appError_('FILE_STORAGE_INVALID', 'ข้อมูลตำแหน่งจัดเก็บไฟล์ไม่ครบถ้วน');
    if (String(attachment.storage_provider).toUpperCase() !== 'CLOUDFLARE_R2') throw appError_('FILE_STORAGE_PROVIDER_MISMATCH', 'ไฟล์นี้จัดเก็บด้วยผู้ให้บริการเดิม ต้องย้ายไฟล์ไป Cloudflare R2 ก่อนดาวน์โหลดผ่านระบบใหม่');

    var downloadId = newId_();
    var fileName = safeFileName_(attachment.original_file_name || attachment.file_name || 'document');
    insertRecord_('FileDownloadLogs', {
      download_id: downloadId, org_id: attachment.org_id, user_id: ctx.user.user_id,
      attachment_id: attachment.attachment_id, storage_provider: attachment.storage_provider,
      storage_key: attachment.storage_key, encrypted_file_name: fileName, password_hash: '',
      created_at: nowIso_(), expires_at: new Date(Date.now() + APP_.FILE_DOWNLOAD_TTL_SECONDS * 1000).toISOString(),
      status: 'CREATING', downloaded_at: '', source_ip: '', user_agent: safeText_(userAgent, 300)
    });

    var response;
    try {
      response = callR2Service_('GET', '/download-link?key=' + encodeURIComponent(attachment.storage_key));
    } catch (serviceError) {
      updateRecordById_('FileDownloadLogs', 'download_id', downloadId, { status: 'FAILED' });
      throw serviceError;
    }
    var downloadUrl = safeHttpsUrl_(response.downloadUrl || response.download_url || response.signedUrl || response.signed_url || response.url || '');
    if (!downloadUrl) {
      updateRecordById_('FileDownloadLogs', 'download_id', downloadId, { status: 'FAILED' });
      throw appError_('FILE_SERVICE_INVALID_RESPONSE', 'Cloudflare Worker ไม่ส่ง HTTPS download URL กลับมา');
    }
    var expiresAt = response.expiresAt || response.expires_at || new Date(Date.now() + APP_.FILE_DOWNLOAD_TTL_SECONDS * 1000).toISOString();
    updateRecordById_('FileDownloadLogs', 'download_id', downloadId, {
      encrypted_file_name: fileName, expires_at: expiresAt, status: 'PREPARED'
    });
    auditUser_(ctx.user, 'PREPARE_SIGNED_DOWNLOAD', 'files', 'BookAttachments', attachmentId, null, {
      download_id: downloadId, expires_at: expiresAt
    });
    return ok_({
      downloadId: downloadId,
      downloadUrl: downloadUrl,
      fileName: fileName,
      expiresAt: expiresAt,
      downloadMode: 'SIGNED_URL'
    });
  } catch (err) { return errorResponse_(err); }
}

function apiConfirmFileDownload(token, downloadId) {
  try {
    var ctx = requireSession_(token);
    var log = findById_('FileDownloadLogs', 'download_id', downloadId);
    if (!log) return fail_('NOT_FOUND', 'ไม่พบรายการดาวน์โหลด');
    assertTenantAccess_(ctx, log.org_id);
    if (log.user_id !== ctx.user.user_id && !ctx.isSuperAdmin) throw appError_('FORBIDDEN', 'ไม่มีสิทธิ์ยืนยันรายการนี้');
    updateRecordById_('FileDownloadLogs', 'download_id', downloadId, { status: 'LINK_OPENED', downloaded_at: nowIso_() });
    auditUser_(ctx.user, 'OPEN_DOWNLOAD_LINK', 'files', 'BookAttachments', log.attachment_id, null, { download_id: downloadId });
    return ok_({ confirmed: true, status: 'LINK_OPENED' });
  } catch (err) { return errorResponse_(err); }
}

function apiSetAttachmentStatus(token, attachmentId, status) {
  try {
    var ctx = requirePermission_(token, 'files.upload');
    var attachment = findById_('BookAttachments', 'attachment_id', attachmentId);
    if (!attachment) return fail_('NOT_FOUND', 'ไม่พบไฟล์แนบ');
    assertTenantAccess_(ctx, attachment.org_id);
    var parentBook = getBookRecord_(attachment.book_direction, attachment.book_id);
    if (!parentBook || !canViewBookRecord_(ctx, parentBook, attachment.book_direction)) throw appError_('FORBIDDEN', 'ไม่มีสิทธิ์จัดการไฟล์แนบนี้');
    if (!ctx.isSuperAdmin && ['ORG_ADMIN', 'REGISTRAR'].indexOf(ctx.role.role_code) < 0 && attachment.uploaded_by !== ctx.user.user_id) throw appError_('FORBIDDEN', 'สามารถจัดการได้เฉพาะไฟล์ที่ตนเองอัปโหลด');
    if (['ACTIVE', 'INACTIVE', 'DELETED'].indexOf(status) < 0) return fail_('INVALID_STATUS', 'สถานะไม่ถูกต้อง');
    if (status === 'DELETED' && attachment.status !== 'DELETED' && attachment.storage_key && String(attachment.storage_provider).toUpperCase() === 'CLOUDFLARE_R2') {
      callR2Service_('DELETE', '/delete?key=' + encodeURIComponent(attachment.storage_key));
    }
    updateRecordById_('BookAttachments', 'attachment_id', attachmentId, { status: status });
    auditUser_(ctx.user, 'CHANGE_ATTACHMENT_STATUS', 'files', 'BookAttachments', attachmentId, { status: attachment.status }, { status: status });
    return ok_({ attachment_id: attachmentId, status: status });
  } catch (err) { return errorResponse_(err); }
}

function enforceSecrecyAccess_(ctx, book) {
  if (ctx.isSuperAdmin) return;
  var secrecy = book.secrecy_id ? findById_('SecrecyLevels', 'secrecy_id', book.secrecy_id) : null;
  if (secrecy && secrecy.access_policy === 'RESTRICTED') {
    var roleCode = ctx.role ? ctx.role.role_code : '';
    var allowed = ['ORG_ADMIN', 'REGISTRAR', 'EXECUTIVE', 'DEPARTMENT_HEAD'];
    if (allowed.indexOf(roleCode) < 0) throw appError_('SECRECY_FORBIDDEN', 'ไม่มีสิทธิ์ดาวน์โหลดเอกสารชั้นความลับนี้');
  }
}

function callR2Service_(method, path, payload) {
  var props = PropertiesService.getScriptProperties();
  var baseUrl = String(props.getProperty('FILE_SERVICE_URL') || '').replace(/\/$/, '');
  var token = String(props.getProperty('FILE_SERVICE_TOKEN') || '');
  if (!baseUrl || !token) throw appError_('FILE_STORAGE_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่า FILE_SERVICE_URL และ FILE_SERVICE_TOKEN ใน Script Properties');
  if (baseUrl.indexOf('https://') !== 0) throw appError_('FILE_SERVICE_INVALID_URL', 'FILE_SERVICE_URL ต้องเป็น HTTPS');

  var requestMethod = String(method || 'GET').toUpperCase();
  var options = {
    method: requestMethod.toLowerCase(),
    headers: { Authorization: 'Bearer ' + token },
    muteHttpExceptions: true,
    followRedirects: false
  };
  if (payload !== undefined && payload !== null) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  var response = UrlFetchApp.fetch(baseUrl + path, options);
  var status = response.getResponseCode();
  var bodyText = response.getContentText() || '{}';
  var body;
  try { body = JSON.parse(bodyText); } catch (e) { body = {}; }
  if (status < 200 || status >= 300 || body.success === false || body.ok === false) {
    throw appError_('FILE_SERVICE_ERROR', safeText_(body.message || body.error || ('Cloudflare Worker ตอบกลับ HTTP ' + status), 300));
  }
  if (body.data && typeof body.data === 'object') return body.data;
  return body;
}

/** ทดสอบ Worker/R2 จาก Apps Script Editor โดยไม่แสดง Secret */
function testR2Connection() {
  var props = PropertiesService.getScriptProperties();
  var baseUrl = String(props.getProperty('FILE_SERVICE_URL') || '').replace(/\/$/, '');
  var token = String(props.getProperty('FILE_SERVICE_TOKEN') || '');
  if (!baseUrl || baseUrl.indexOf('https://') !== 0) {
    throw new Error('กรุณากำหนด FILE_SERVICE_URL เป็น HTTPS URL ของ Cloudflare Worker');
  }
  if (!token) throw new Error('กรุณากำหนด FILE_SERVICE_TOKEN เป็นค่าเดียวกับ Worker Secret API_TOKEN');
  var response = UrlFetchApp.fetch(baseUrl + '/health', {
    method: 'get', muteHttpExceptions: true, followRedirects: false
  });
  var status = response.getResponseCode();
  var bodyText = response.getContentText() || '{}';
  var body;
  try { body = JSON.parse(bodyText); } catch (e) { body = {}; }
  if (status < 200 || status >= 300 || body.success === false || body.ok === false) {
    throw new Error('เชื่อมต่อ Cloudflare Worker ไม่สำเร็จ (HTTP ' + status + ')');
  }
  return { success: true, status: status, provider: 'CLOUDFLARE_R2', message: 'เชื่อมต่อ Cloudflare Worker ได้แล้ว' };
}

function getStorageProvider_() {
  var provider = String(PropertiesService.getScriptProperties().getProperty('FILE_STORAGE_PROVIDER') || '').trim().toUpperCase();
  if (!provider) throw appError_('FILE_STORAGE_PROVIDER_NOT_SELECTED', 'กรุณากำหนด FILE_STORAGE_PROVIDER เป็น CLOUDFLARE_R2');
  if (provider !== 'CLOUDFLARE_R2') throw appError_('FILE_STORAGE_PROVIDER_UNSUPPORTED', 'โค้ดชุดนี้เชื่อมต่อ Cloudflare R2 เท่านั้น กรุณาตั้ง FILE_STORAGE_PROVIDER=CLOUDFLARE_R2');
  return provider;
}

/* -------------------------------------------------------------------------- */
/* 13. INTERNAL AUTHORIZATION AND TENANT SCOPE                                 */
/* -------------------------------------------------------------------------- */

function requireSession_(token) {
  token = String(token || '');
  if (token.length < 32) throw appError_('UNAUTHENTICATED', 'กรุณาเข้าสู่ระบบใหม่');
  var tokenHash = hashToken_(token);
  var session = findOne_('Sessions', function (s) { return s.token_hash === tokenHash && !s.revoked_at; });
  if (!session || new Date(session.expires_at).getTime() <= Date.now()) throw appError_('SESSION_EXPIRED', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
  var user = findById_('Users', 'user_id', session.user_id);
  if (!user || user.status !== 'ACTIVE') throw appError_('USER_INACTIVE', 'บัญชีผู้ใช้ไม่พร้อมใช้งาน');
  var org = null;
  if (session.org_id) {
    org = findById_('Organizations', 'org_id', session.org_id);
    if (!org || org.status !== 'ACTIVE') throw appError_('ORG_INACTIVE', 'หน่วยงานถูกระงับ กรุณาติดต่อผู้ดูแล');
  }
  var role = findById_('Roles', 'role_id', user.role_id);
  if (!role || role.status !== 'ACTIVE') throw appError_('ROLE_INACTIVE', 'บทบาทผู้ใช้ไม่พร้อมใช้งาน');
  var isSuperAdmin = role.role_code === 'SUPER_ADMIN' && !user.org_id && !role.org_id;
  if (role.role_code === 'SUPER_ADMIN' && !isSuperAdmin) throw appError_('ROLE_SCOPE_INVALID', 'บัญชี Super Admin ต้องเป็นบัญชีส่วนกลางเท่านั้น');
  if (!isSuperAdmin && role.org_id !== user.org_id) throw appError_('ROLE_SCOPE_INVALID', 'บทบาทผู้ใช้ไม่ตรงกับหน่วยงาน');
  updateRecordById_('Sessions', 'session_id', session.session_id, { last_seen_at: nowIso_() });
  return { session: session, user: user, org: org, role: role, orgId: user.org_id || '', isSuperAdmin: isSuperAdmin };
}

function requirePermission_(token, permissionCode) {
  var ctx = requireSession_(token);
  if (!hasPermission_(ctx, permissionCode)) throw appError_('FORBIDDEN', 'คุณไม่มีสิทธิ์ดำเนินการนี้ (' + permissionCode + ')');
  return ctx;
}

function hasPermission_(ctx, permissionCode) {
  if (ctx.isSuperAdmin) return true;
  var rolePermissions = getRecords_('RolePermissions').filter(function (p) { return p.role_id === ctx.role.role_id; });
  var permission = rolePermissions.find(function (p) { return p.permission_code === permissionCode; });
  return !!(permission && truthy_(permission.is_allowed));
}

function getPermissionsForRole_(role) {
  if (!role) return [];
  if (role.role_code === 'SUPER_ADMIN') return PERMISSION_DEFINITIONS_.map(function (p) { return p[0]; });
  return getRecords_('RolePermissions').filter(function (p) { return p.role_id === role.role_id && truthy_(p.is_allowed); }).map(function (p) { return p.permission_code; });
}

function resolveOrgScope_(ctx, requestedOrgId) {
  var requested = String(requestedOrgId || '').trim();
  if (ctx.isSuperAdmin) return requested;
  if (!ctx.orgId) throw appError_('ORG_CONTEXT_REQUIRED', 'ไม่พบข้อมูลหน่วยงานของผู้ใช้');
  if (requested && requested !== ctx.orgId) throw appError_('TENANT_FORBIDDEN', 'ไม่สามารถเข้าถึงข้อมูลต่างหน่วยงาน');
  return ctx.orgId;
}

function requireOrganizationTarget_(orgId) {
  if (!orgId) throw appError_('ORG_TARGET_REQUIRED', 'กรุณาเลือกหน่วยงานก่อนบันทึกข้อมูล');
  var org = findById_('Organizations', 'org_id', orgId);
  if (!org || org.status !== 'ACTIVE') throw appError_('ORG_NOT_AVAILABLE', 'ไม่พบหน่วยงานหรือหน่วยงานไม่ได้เปิดใช้งาน');
  return org;
}

function canViewBookRecord_(ctx, record, direction) {
  if (ctx.isSuperAdmin) return true;
  var roleCode = ctx.role ? ctx.role.role_code : '';
  if (['ORG_ADMIN', 'REGISTRAR', 'EXECUTIVE', 'AUDITOR'].indexOf(roleCode) >= 0) return true;
  if (roleCode === 'DEPARTMENT_HEAD' && ctx.user.department_id && record.assigned_department_id === ctx.user.department_id) return true;
  if (direction === 'INCOMING' && record.assigned_user_id === ctx.user.user_id) return true;
  // โหลดตารางการมอบหมายเพียงครั้งเดียวต่อคำขอ ลดการอ่าน Spreadsheet ซ้ำในรายงาน
  if (!ctx._assignmentIndex) {
    ctx._assignmentIndex = {};
    getRecords_('BookAssignments').forEach(function (assignment) {
      var key = assignment.org_id + '|' + assignment.book_direction + '|' + assignment.book_id;
      if (!ctx._assignmentIndex[key]) ctx._assignmentIndex[key] = { users: {}, departments: {} };
      if (assignment.to_user_id) ctx._assignmentIndex[key].users[assignment.to_user_id] = true;
      if (assignment.to_department_id) ctx._assignmentIndex[key].departments[assignment.to_department_id] = true;
    });
  }
  var recordId = record.incoming_id || record.outgoing_id;
  var assignmentIndex = ctx._assignmentIndex[record.org_id + '|' + direction + '|' + recordId];
  if (!assignmentIndex) return false;
  if (assignmentIndex.users[ctx.user.user_id]) return true;
  return roleCode === 'DEPARTMENT_HEAD' && !!(ctx.user.department_id && assignmentIndex.departments[ctx.user.department_id]);
}

function assertTenantAccess_(ctx, orgId) {
  if (ctx.isSuperAdmin) return true;
  if (!orgId || orgId !== ctx.orgId) throw appError_('TENANT_FORBIDDEN', 'ไม่สามารถเข้าถึงข้อมูลต่างหน่วยงาน');
  return true;
}

function buildMenuForPermissions_(permissions, isSuperAdmin) {
  var set = {};
  permissions.forEach(function (p) { set[p] = true; });
  var menus = [];
  function add(key, label, permission) { if (isSuperAdmin || set[permission]) menus.push({ key: key, label: label }); }
  if (isSuperAdmin) add('organizations', 'จัดการหน่วยงาน', 'organizations.view');
  add('dashboard', 'Dashboard', 'dashboard.view');
  add('incoming', 'ทะเบียนหนังสือรับ', 'books.incoming.view');
  add('outgoing', 'ทะเบียนหนังสือส่ง', 'books.outgoing.view');
  if (isSuperAdmin || set['workflow.action'] || set['workflow.assign'] || set['workflow.complete']) menus.push({ key: 'workflow', label: 'เสนอหนังสือและสั่งการ' });
  if (isSuperAdmin || set['books.incoming.view'] || set['books.outgoing.view']) menus.push({ key: 'tracking', label: 'ติดตามสถานะหนังสือ' });
  add('reports', 'รายงานและสถิติ', 'reports.view');
  add('departments', 'ฝ่าย/กอง', 'departments.view');
  add('users', 'จัดการผู้ใช้', 'users.view');
  if (isSuperAdmin || set['settings.manage']) add('settings', 'ตั้งค่าระบบ', 'settings.manage');
  if (isSuperAdmin || set['audit.view']) add('audit', 'ประวัติการใช้งาน', 'audit.view');
  return menus;
}

/* -------------------------------------------------------------------------- */
/* 14. SHEET DATA ACCESS HELPERS                                               */
/* -------------------------------------------------------------------------- */

function getSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('กรุณากำหนด SPREADSHEET_ID ใน Script Properties');
  props.setProperty('SPREADSHEET_ID', active.getId());
  return active;
}

function getSheet_(sheetName) {
  var sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error('ไม่พบ Sheet: ' + sheetName + ' กรุณารัน initializeDatabase_()');
  return sheet;
}

function getHeaders_(sheet) {
  var lastColumn = sheet.getLastColumn();
  if (!lastColumn) return [];
  return sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (x) { return String(x || '').trim(); });
}

function getRecords_(sheetName) {
  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  var headers = getHeaders_(sheet);
  if (lastRow < 2 || !headers.length) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values.map(function (row) {
    var obj = {};
    headers.forEach(function (header, index) {
      if (header) obj[header] = normalizeSheetValue_(row[index]);
    });
    return obj;
  }).filter(function (obj) { return Object.keys(obj).some(function (k) { return obj[k] !== '' && obj[k] !== null; }); });
}

function insertRecord_(sheetName, record) {
  var sheet = getSheet_(sheetName);
  var headers = getHeaders_(sheet);
  var row = headers.map(function (header) {
    var value = Object.prototype.hasOwnProperty.call(record, header) ? record[header] : '';
    return sheetValue_(value);
  });
  sheet.appendRow(row);
  return record;
}

function findOne_(sheetName, predicate) {
  var records = getRecords_(sheetName);
  for (var i = 0; i < records.length; i++) if (predicate(records[i])) return records[i];
  return null;
}

function findById_(sheetName, idField, idValue) {
  if (!idValue) return null;
  return findOne_(sheetName, function (r) { return String(r[idField] || '') === String(idValue); });
}

function updateRecordById_(sheetName, idField, idValue, updates) {
  var sheet = getSheet_(sheetName);
  var headers = getHeaders_(sheet);
  var idCol = headers.indexOf(idField) + 1;
  if (!idCol) throw new Error('ไม่พบคอลัมน์ ' + idField + ' ใน ' + sheetName);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var finder = sheet.getRange(2, idCol, lastRow - 1, 1).createTextFinder(String(idValue)).matchEntireCell(true);
  var cell = finder.findNext();
  if (!cell) return false;
  var rowNumber = cell.getRow();
  var current = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  headers.forEach(function (header, index) {
    if (Object.prototype.hasOwnProperty.call(updates, header)) current[index] = sheetValue_(updates[header]);
  });
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([current]);
  return true;
}

function deleteRecordById_(sheetName, idField, idValue) {
  var sheet = getSheet_(sheetName);
  var headers = getHeaders_(sheet);
  var idCol = headers.indexOf(idField) + 1;
  if (!idCol) return false;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var cell = sheet.getRange(2, idCol, lastRow - 1, 1).createTextFinder(String(idValue)).matchEntireCell(true).findNext();
  if (!cell) return false;
  sheet.deleteRow(cell.getRow());
  return true;
}

function ensureMetaValue_(key, value) {
  var row = findOne_('SystemMeta', function (r) { return r.meta_key === key; });
  if (row) updateRecordById_('SystemMeta', 'meta_key', key, { meta_value: value, updated_at: nowIso_() });
  else insertRecord_('SystemMeta', { meta_key: key, meta_value: value, updated_at: nowIso_() });
}

function getSettingsMap_(orgId) {
  var map = {};
  getRecords_('SystemSettings').filter(function (r) { return r.org_id === orgId; }).forEach(function (r) { map[r.setting_key] = r.setting_value; });
  return map;
}

function getBookRecord_(direction, bookId) {
  return direction === 'OUTGOING'
    ? findById_('OutgoingBooks', 'outgoing_id', bookId)
    : findById_('IncomingBooks', 'incoming_id', bookId);
}

/* -------------------------------------------------------------------------- */
/* 15. AUDIT, NOTIFICATION AND LOGIN LOG HELPERS                               */
/* -------------------------------------------------------------------------- */

function appendBookAction_(orgId, direction, bookId, actionType, title, detail, previousStatus, newStatus, actor, attachmentId) {
  var actionId = newId_();
  insertRecord_('BookActions', {
    action_id: actionId, org_id: orgId, book_direction: direction,
    book_id: bookId, action_type: actionType, action_title: safeText_(title, 200),
    action_detail: safeText_(detail, 5000), previous_status: previousStatus || '',
    new_status: newStatus || '', actor_user_id: actor ? actor.user_id : '',
    actor_department_id: actor ? actor.department_id : '', action_at: nowIso_(),
    source_ip: '', attachment_id: attachmentId || ''
  });
  return actionId;
}

function createNotification_(orgId, userId, type, title, message, referenceType, referenceId) {
  insertRecord_('Notifications', {
    notification_id: newId_(), org_id: orgId, recipient_user_id: userId,
    notification_type: type, title: safeText_(title, 200), message: safeText_(message, 1000),
    reference_type: referenceType, reference_id: referenceId,
    is_read: false, read_at: '', created_at: nowIso_(), expires_at: ''
  });
}

function auditUser_(user, actionType, moduleKey, entityType, entityId, before, after) {
  insertRecord_('AuditLogs', {
    audit_log_id: newId_(), org_id: user ? (user.org_id || '') : '',
    actor_user_id: user ? user.user_id : 'SYSTEM',
    actor_role_id: user ? user.role_id : '', action_type: actionType,
    module_key: moduleKey, entity_type: entityType, entity_id: String(entityId || ''),
    before_json: before ? JSON.stringify(safeAuditObject_(before)) : '',
    after_json: after ? JSON.stringify(safeAuditObject_(after)) : '',
    ip_address: '', user_agent: '', occurred_at: nowIso_()
  });
}

function auditSystem_(actionType, moduleKey, entityType, entityId, before, after) {
  insertRecord_('AuditLogs', {
    audit_log_id: newId_(), org_id: '', actor_user_id: 'SYSTEM', actor_role_id: '',
    action_type: actionType, module_key: moduleKey, entity_type: entityType,
    entity_id: String(entityId || ''), before_json: before ? JSON.stringify(safeAuditObject_(before)) : '',
    after_json: after ? JSON.stringify(safeAuditObject_(after)) : '', ip_address: '',
    user_agent: '', occurred_at: nowIso_()
  });
}

function writeLoginLog_(orgId, userId, username, success, reason, userAgent) {
  insertRecord_('LoginLogs', {
    login_log_id: newId_(), org_id: orgId || '', user_id: userId || '',
    username_attempt: safeText_(username, 100), success: success,
    fail_reason: safeText_(reason, 100), logged_in_at: nowIso_(),
    ip_address: '', user_agent: safeText_(userAgent, 300)
  });
}

function registerLoginFailure_(key) {
  var cache = CacheService.getScriptCache();
  var count = Number(cache.get(key) || 0) + 1;
  if (count >= APP_.LOGIN_FAILURE_LIMIT) {
    cache.put(key, String(Date.now() + APP_.LOGIN_LOCK_MINUTES * 60000), APP_.LOGIN_LOCK_MINUTES * 60);
  } else {
    cache.put(key, String(count), APP_.LOGIN_LOCK_MINUTES * 60);
  }
}

function revokeSessionsForUser_(userId) {
  getRecords_('Sessions').filter(function (s) { return s.user_id === userId && !s.revoked_at; }).forEach(function (s) {
    updateRecordById_('Sessions', 'session_id', s.session_id, { revoked_at: nowIso_() });
  });
}

function revokeSessionsForOrg_(orgId) {
  getRecords_('Sessions').filter(function (s) { return s.org_id === orgId && !s.revoked_at; }).forEach(function (s) {
    updateRecordById_('Sessions', 'session_id', s.session_id, { revoked_at: nowIso_() });
  });
}

/* -------------------------------------------------------------------------- */
/* 16. PASSWORDS, RANDOM VALUES AND CRYPTOGRAPHY                               */
/* -------------------------------------------------------------------------- */

function hashPassword_(password, salt) {
  var pepper = PropertiesService.getScriptProperties().getProperty('PASSWORD_PEPPER') || '';
  var derived = pbkdf2Sha256Hex_(String(password) + pepper, String(salt), APP_.PBKDF2_ITERATIONS);
  return 'pbkdf2_sha256$' + APP_.PBKDF2_ITERATIONS + '$' + derived;
}

function verifyPassword_(password, salt, storedHash) {
  if (!salt || !storedHash) return false;
  var parts = String(storedHash).split('$');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2_sha256') return false;
  var iterations = Number(parts[1]);
  if (!iterations || iterations < 10000 || iterations > 300000) return false;
  var pepper = PropertiesService.getScriptProperties().getProperty('PASSWORD_PEPPER') || '';
  var candidate = pbkdf2Sha256Hex_(String(password) + pepper, String(salt), iterations);
  return constantTimeEquals_(candidate, parts[2]);
}

function pbkdf2Sha256Hex_(password, salt, iterations) {
  // PBKDF2-HMAC-SHA256, block index 1 (32-byte derived key).
  var block = Utilities.newBlob(salt + '\x00\x00\x00\x01').getBytes();
  var u = Utilities.computeHmacSha256Signature(block, password);
  var t = u.slice();
  for (var i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, password);
    for (var j = 0; j < t.length; j++) t[j] = (t[j] ^ u[j]);
  }
  return bytesToHex_(t);
}

function hashToken_(token) {
  var secret = PropertiesService.getScriptProperties().getProperty('SESSION_SIGNING_SECRET') || '';
  return bytesToHex_(Utilities.computeHmacSha256Signature(String(token), secret));
}

function sha256Hex_(value) {
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8));
}

function randomHex_(byteLength) {
  var hex = '';
  while (hex.length < byteLength * 2) {
    var uuid = Utilities.getUuid() + Utilities.getUuid() + String(Date.now());
    hex += sha256Hex_(uuid);
  }
  return hex.substring(0, byteLength * 2);
}

function newSessionToken_() {
  return randomHex_(32) + randomHex_(16);
}

function newId_() {
  return Utilities.getUuid().replace(/-/g, '');
}

function randomPassword_(length) {
  var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_';
  var output = '';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid() + Date.now());
  var pool = bytes.map(function (b) { return (b + 256) % 256; });
  var index = 0;
  while (output.length < length) {
    if (index >= pool.length) {
      bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid() + Date.now() + index);
      pool = bytes.map(function (b) { return (b + 256) % 256; });
      index = 0;
    }
    output += alphabet.charAt(pool[index++] % alphabet.length);
  }
  return output;
}

function bytesToHex_(bytes) {
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function constantTimeEquals_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function ensureSecretProperty_(key) {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty(key)) props.setProperty(key, randomHex_(48));
}

/* -------------------------------------------------------------------------- */
/* 17. SERIALIZATION, VALIDATION AND GENERAL UTILITIES                         */
/* -------------------------------------------------------------------------- */

function ok_(data) { return { ok: true, data: serializeForClient_(data) }; }
function fail_(code, message) { return { ok: false, error: { code: code, message: message } }; }
function errorResponse_(err) {
  var code = err && err.code ? err.code : 'SERVER_ERROR';
  var message = err && err.message ? err.message : 'เกิดข้อผิดพลาดในระบบ';
  console.error(code + ': ' + message);
  return fail_(code, message);
}
function appError_(code, message) { var err = new Error(message); err.code = code; return err; }

function serializeForClient_(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeForClient_);
  if (typeof value === 'object') {
    var result = {};
    Object.keys(value).forEach(function (key) {
      if (key.charAt(0) === '_') return;
      result[key] = serializeForClient_(value[key]);
    });
    return result;
  }
  return value;
}

function normalizeSheetValue_(value) {
  if (value instanceof Date) return value.toISOString();
  return value;
}

function sheetValue_(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string' && /^[=+@]/.test(value)) return "'" + value;
  return value;
}

function publicUser_(user) {
  if (!user) return null;
  return {
    user_id: user.user_id, org_id: user.org_id || '', username: user.username,
    full_name: user.full_name, email: user.email, phone: user.phone,
    position: user.position, department_id: user.department_id,
    role_id: user.role_id, avatar_url: user.avatar_url, status: user.status,
    must_change_password: truthy_(user.must_change_password), last_login_at: user.last_login_at
  };
}

function publicOrganization_(org) {
  if (!org) return null;
  var result = {};
  Object.keys(org).forEach(function (key) { result[key] = org[key]; });
  return result;
}

function publicAttachment_(attachment) {
  if (!attachment) return null;
  return {
    attachment_id: attachment.attachment_id,
    org_id: attachment.org_id,
    book_direction: attachment.book_direction,
    book_id: attachment.book_id,
    file_category: attachment.file_category,
    file_name: attachment.file_name,
    original_file_name: attachment.original_file_name,
    mime_type: attachment.mime_type,
    file_extension: attachment.file_extension,
    file_size_bytes: attachment.file_size_bytes,
    is_primary: truthy_(attachment.is_primary),
    access_level: attachment.access_level,
    uploaded_by: attachment.uploaded_by,
    uploaded_at: attachment.uploaded_at,
    status: attachment.status
  };
}

function publicRole_(role) {
  if (!role) return null;
  return {
    role_id: role.role_id, org_id: role.org_id || '', role_code: role.role_code,
    role_name: role.role_name, role_scope: role.role_scope,
    description: role.description, is_system: truthy_(role.is_system), status: role.status
  };
}

function safeAuditObject_(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  var clone = Array.isArray(obj) ? [] : {};
  Object.keys(obj).forEach(function (key) {
    if (/password|token|secret|salt|credential|base64_data/i.test(key)) return;
    var value = obj[key];
    if (value && typeof value === 'object') clone[key] = safeAuditObject_(value);
    else clone[key] = value;
  });
  return clone;
}

function safeText_(value, maxLength) {
  var text = String(value === null || value === undefined ? '' : value).trim();
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  return text.substring(0, maxLength || 5000);
}

function safeFileName_(name) {
  var value = safeText_(name, 180).replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/^\.+/, '');
  return value || 'document';
}

function safeHttpsUrl_(url) {
  var value = safeText_(url, 2000);
  if (!value) return '';
  if (!/^https:\/\//i.test(value)) return '';
  return value;
}

function normalizeOrgCode_(code) {
  return safeText_(code, 40).toUpperCase().replace(/\s+/g, '');
}

function normalizeDateString_(value) {
  if (!value) return '';
  if (value instanceof Date && !isNaN(value.getTime())) return Utilities.formatDate(value, getTimezone_(), 'yyyy-MM-dd');
  var text = safeText_(value, 40);
  var match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return match[1] + '-' + match[2] + '-' + match[3];
  var parsed = new Date(text);
  return isNaN(parsed.getTime()) ? '' : Utilities.formatDate(parsed, getTimezone_(), 'yyyy-MM-dd');
}

function todayString_() { return Utilities.formatDate(new Date(), getTimezone_(), 'yyyy-MM-dd'); }
function nowIso_() { return new Date().toISOString(); }
function getTimezone_() {
  return PropertiesService.getScriptProperties().getProperty('APP_TIMEZONE') || APP_.DEFAULT_TIMEZONE;
}
function getFileExtension_(fileName) {
  var match = String(fileName || '').match(/\.([A-Za-z0-9]{1,12})$/);
  return match ? match[1].toLowerCase() : '';
}
function truthy_(value) {
  return value === true || value === 1 || String(value).toLowerCase() === 'true' || String(value) === '1';
}
function sortNewest_(a, b) {
  var av = a.created_at || a.receive_date || a.send_date || a.register_date || '';
  var bv = b.created_at || b.receive_date || b.send_date || b.register_date || '';
  return new Date(bv).getTime() - new Date(av).getTime();
}

/* -------------------------------------------------------------------------- */
/* 18. OPTIONAL MAINTENANCE FUNCTIONS (RUN FROM EDITOR)                        */
/* -------------------------------------------------------------------------- */

/** Revoke expired sessions and remove expired cache-independent records. */
function maintenanceCleanup_() {
  var now = Date.now();
  var sessionCount = 0;
  getRecords_('Sessions').forEach(function (s) {
    if (!s.revoked_at && new Date(s.expires_at).getTime() < now) {
      updateRecordById_('Sessions', 'session_id', s.session_id, { revoked_at: nowIso_() });
      sessionCount++;
    }
  });
  var downloadCount = 0;
  getRecords_('FileDownloadLogs').forEach(function (d) {
    if (d.status === 'PREPARED' && new Date(d.expires_at).getTime() < now) {
      updateRecordById_('FileDownloadLogs', 'download_id', d.download_id, { status: 'EXPIRED' });
      downloadCount++;
    }
  });
  return { revokedSessions: sessionCount, expiredDownloads: downloadCount };
}

/** Install a daily maintenance trigger. Run manually once if desired. */
function installMaintenanceTrigger_() {
  var existing = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === 'maintenanceCleanup_';
  });
  if (!existing) ScriptApp.newTrigger('maintenanceCleanup_').timeBased().everyDays(1).atHour(3).create();
  return { installed: true };
}

/** Diagnostic check; does not expose secrets. Run manually from editor. */
function diagnoseConfiguration_() {
  var props = PropertiesService.getScriptProperties();
  var required = ['SPREADSHEET_ID', 'PASSWORD_PEPPER', 'SESSION_SIGNING_SECRET'];
  var status = {};
  required.forEach(function (key) { status[key] = !!props.getProperty(key); });
  status.IMGBB_API_KEY = !!props.getProperty('IMGBB_API_KEY');
  status.FILE_SERVICE_URL = !!props.getProperty('FILE_SERVICE_URL');
  status.FILE_SERVICE_TOKEN = !!props.getProperty('FILE_SERVICE_TOKEN');
  status.FILE_STORAGE_PROVIDER = String(props.getProperty('FILE_STORAGE_PROVIDER') || '').toUpperCase() === 'CLOUDFLARE_R2';
  status.R2_CONFIGURATION_READY = !!props.getProperty('FILE_SERVICE_URL') && !!props.getProperty('FILE_SERVICE_TOKEN') && String(props.getProperty('FILE_STORAGE_PROVIDER') || '').toUpperCase() === 'CLOUDFLARE_R2';
  status.webAppUrl = ScriptApp.getService().getUrl() || '';
  status.spreadsheetAccessible = false;
  try { status.spreadsheetAccessible = !!getSpreadsheet_().getId(); } catch (e) { status.spreadsheetError = e.message; }
  return status;
}

/* -------------------------------------------------------------------------- */
/* END OF Code.gs                                                              */
/* -------------------------------------------------------------------------- */

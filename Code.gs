/**
 * ระบบทะเบียนรับ–ส่งหนังสืออิเล็กทรอนิกส์ | Backend: Google Apps Script V8
 * Database: Google Sheets | Private storage: Google Drive | Images: ImgBB
 * Frontend: GitHub Pages (index.html, dashboard.html)
 * Production requests must pass through a signed API Gateway.
 *
 * FIRST RUN: set Script Properties, then run initializeSystem() manually.
 * Required properties: PASSWORD_PEPPER (32+ chars), GATEWAY_SHARED_SECRET (32+),
 * BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD (12+ chars, letters+digits).
 * Optional: IMGBB_API_KEY, PDF_ENCRYPTION_ENDPOINT, PDF_ENCRYPTION_API_KEY,
 * APP_BASE_URL and MAIL_FROM_NAME. SPREADSHEET_ID and DRIVE_ROOT_FOLDER_ID are auto-created.
 * Bootstrap Super Admin can enter agency code SYSTEM to manage the first agency.
 * DEPLOY: Web App / Execute as Me / Access Anyone. Do not call this URL from
 * GitHub Pages; use the API Gateway. Gateway signs the envelope defined below.
 *
 * Gateway envelope:
 * {timestamp,nonce,secureRandomHex,payload:{action,data,token,userAgent,ipHint},signature}
 * Canonical signature text:
 * timestamp + "\n" + nonce + "\n" + secureRandomHex.toLowerCase() + "\n" + JSON.stringify(payload)
 * signature = Base64URL(HMAC-SHA256(canonicalText, GATEWAY_SHARED_SECRET))
 * secureRandomHex must contain >=512 hex chars produced by crypto.getRandomValues.
 *
 * PDF NOTE: AES-256 PDF encryption is delegated to a configured encryption
 * service. Apps Script has no native PDF password-encryption API. This module
 * fails closed if that service is not configured or does not return an encrypted PDF.
 */

/* ========================================================================== */
/* 01. CONSTANTS AND SECRET PROPERTY NAMES                                    */
/* ========================================================================== */
var APP = {
  NAME: 'ระบบทะเบียนรับ–ส่งหนังสือ', VERSION: '1.0.0', TIMEZONE: 'Asia/Bangkok',
  SESSION_TTL_SECONDS: 21600, GATEWAY_CLOCK_SKEW_SECONDS: 300,
  GATEWAY_NONCE_TTL_SECONDS: 600, MAX_REQUEST_BYTES: 12000000,
  MAX_UPLOAD_BYTES: 8000000, MAX_DOWNLOAD_BYTES: 8000000,
  MAX_PAGE_SIZE: 200, DEFAULT_PAGE_SIZE: 50, PASSWORD_MIN_LENGTH: 12,
  PBKDF2_ITERATIONS: 120000, LOGIN_MAX_FAILURES: 5, LOGIN_LOCK_MINUTES: 15,
  PASSWORD_RESET_TTL_MINUTES: 30, MAX_AUDIT_LIST: 250, MAX_BACKUP_ROWS: 100000,
  DRIVE_ROOT_FOLDER_NAME: 'DocumentRegistry_Private',
  DRIVE_AGENCY_FOLDERS: ['Incoming', 'Outgoing', 'Attachments', 'GeneratedPDF', 'Backups'],
  SHEET_HEADER_COLOR: '#17365D', SHEET_HEADER_FONT_COLOR: '#FFFFFF'
};

var PROP = {
  SPREADSHEET_ID: 'SPREADSHEET_ID', DRIVE_ROOT_FOLDER_ID: 'DRIVE_ROOT_FOLDER_ID',
  GATEWAY_SHARED_SECRET: 'GATEWAY_SHARED_SECRET', PASSWORD_PEPPER: 'PASSWORD_PEPPER',
  IMGBB_API_KEY: 'IMGBB_API_KEY', PDF_ENCRYPTION_ENDPOINT: 'PDF_ENCRYPTION_ENDPOINT',
  PDF_ENCRYPTION_API_KEY: 'PDF_ENCRYPTION_API_KEY',
  BOOTSTRAP_ADMIN_USERNAME: 'BOOTSTRAP_ADMIN_USERNAME',
  BOOTSTRAP_ADMIN_PASSWORD: 'BOOTSTRAP_ADMIN_PASSWORD',
  BOOTSTRAP_ADMIN_EMAIL: 'BOOTSTRAP_ADMIN_EMAIL', APP_BASE_URL: 'APP_BASE_URL',
  MAIL_FROM_NAME: 'MAIL_FROM_NAME', ALLOW_DIRECT_API: 'ALLOW_DIRECT_API',
  SYSTEM_INITIALIZED: 'SYSTEM_INITIALIZED'
};

/* ========================================================================== */
/* 02. COMPLETE GOOGLE SHEETS SCHEMA                                          */
/* ========================================================================== */
var DB_SCHEMA = {
  SystemConfig: ['config_key','config_value','value_type','category','description','is_public','created_at','updated_at','updated_by'],
  Agencies: ['agency_id','agency_code','agency_name','agency_short_name','agency_type','parent_agency_id','logo_url','address','village','building','street','subdistrict','district','province','postal_code','phone','fax','email','website','timezone','fiscal_year_start_month','incoming_prefix','outgoing_prefix','current_fiscal_year','drive_folder_id','status','settings_json','created_by','created_at','updated_by','updated_at','deleted_at'],
  Users: ['user_id','agency_id','username','password_hash','password_salt','password_algorithm','password_iterations','display_name','first_name','last_name','email','phone','position','department_id','role_id','is_super_admin','status','must_change_password','failed_login_count','locked_until','last_login_at','last_password_change_at','avatar_url','notification_preferences_json','created_by','created_at','updated_by','updated_at','deleted_at'],
  Departments: ['department_id','agency_id','department_code','department_name','parent_department_id','head_user_id','phone','email','sort_order','status','created_by','created_at','updated_by','updated_at','deleted_at'],
  Roles: ['role_id','agency_id','role_code','role_name','role_description','is_system_role','is_active','created_by','created_at','updated_by','updated_at'],
  Permissions: ['permission_id','permission_code','permission_name','permission_group','permission_description','created_at'],
  RolePermissions: ['role_permission_id','role_id','permission_code','agency_id','created_by','created_at'],
  IncomingBooks: ['book_id','agency_id','registration_no','registration_year','sequence_no','received_date','document_number','document_date','sender_name','sender_agency','sender_address','sender_contact','subject','summary','document_type_id','category_id','priority_level','confidentiality_level','recipient_name','recipient_position','department_id','responsible_user_id','due_date','received_channel','tracking_number','status','parent_book_id','external_reference','remarks','primary_attachment_id','attachment_count','tags_json','created_by','created_at','updated_by','updated_at','deleted_at'],
  OutgoingBooks: ['book_id','agency_id','registration_no','registration_year','sequence_no','sent_date','document_number','document_date','recipient_name','recipient_agency','recipient_address','recipient_contact','subject','summary','document_type_id','category_id','priority_level','confidentiality_level','signatory_user_id','signatory_name','signatory_position','department_id','responsible_user_id','sent_channel','tracking_number','status','related_incoming_book_id','external_reference','remarks','primary_attachment_id','attachment_count','tags_json','created_by','created_at','updated_by','updated_at','deleted_at'],
  Assignments: ['assignment_id','agency_id','book_type','book_id','assigned_from_user_id','assigned_to_user_id','assigned_to_department_id','assignment_title','instructions','priority_level','assigned_at','due_at','status','completed_at','completion_note','created_by','created_at','updated_by','updated_at'],
  WorkflowLogs: ['workflow_id','agency_id','book_type','book_id','action_type','from_status','to_status','from_user_id','to_user_id','to_department_id','action_note','action_at','attachment_id','metadata_json','created_by','created_at'],
  Attachments: ['attachment_id','agency_id','book_type','book_id','assignment_id','drive_file_id','drive_folder_id','original_file_name','stored_file_name','file_extension','mime_type','size_bytes','checksum_sha256','category','description','is_password_protected','status','uploaded_by','uploaded_at','updated_by','updated_at','deleted_at'],
  MediaAssets: ['media_id','agency_id','owner_type','owner_id','media_type','provider','image_url','display_url','thumbnail_url','image_name','mime_type','size_bytes','width','height','delete_hash','status','uploaded_by','uploaded_at','created_at'],
  DocumentTypes: ['document_type_id','agency_id','type_code','type_name','description','default_prefix','sort_order','is_active','created_by','created_at','updated_by','updated_at'],
  BookCategories: ['category_id','agency_id','category_code','category_name','description','sort_order','is_active','created_by','created_at','updated_by','updated_at'],
  SequenceCounters: ['counter_id','agency_id','book_type','fiscal_year','prefix','last_number','updated_at','updated_by'],
  Notifications: ['notification_id','agency_id','user_id','notification_type','title','message','reference_type','reference_id','target_url','is_read','read_at','created_at','expires_at'],
  AuditLogs: ['audit_id','agency_id','user_id','username','action','module','entity_type','entity_id','description','before_json','after_json','request_id','ip_hint','user_agent','created_at'],
  DownloadLogs: ['download_id','agency_id','user_id','attachment_id','drive_file_id_hash','file_name','mime_type','size_bytes','download_type','request_id','downloaded_at','status'],
  FilePasswordLogs: ['file_password_log_id','agency_id','user_id','attachment_id','password_hash','password_algorithm','file_name','purpose','created_at','expires_at','status','request_id'],
  PasswordResetTokens: ['reset_id','user_id','agency_id','token_hash','created_at','expires_at','used_at','status'],
  BackupLogs: ['backup_id','agency_id','drive_file_id','file_name','size_bytes','backup_type','row_count','status','created_by','created_at','restored_by','restored_at','notes'],
  Sessions: ['session_id','token_hash','user_id','agency_id','issued_at','expires_at','last_seen_at','revoked_at','status','user_agent_hint'],
  LoginAttempts: ['attempt_id','agency_code','username','attempted_at','success','reason','ip_hint'],
  DriveFolderIndex: ['folder_index_id','agency_id','folder_type','drive_folder_id','folder_name','created_at']
};

/* ========================================================================== */
/* 03. PERMISSIONS                                                            */
/* ========================================================================== */
var ACTION_PERMISSIONS = {
  'auth.me':'profile.read','auth.logout':'profile.read','auth.changePassword':'profile.read','auth.updateProfile':'profile.read',
  'search.global':'profile.read','reports.globalSummary':'reports.read',
  'agencies.list':'agencies.read','agencies.get':'agencies.read','agencies.create':'agencies.manage','agencies.update':'agencies.manage','agencies.deactivate':'agencies.manage',
  'users.list':'users.read','users.get':'users.read','users.create':'users.manage','users.update':'users.manage','users.deactivate':'users.manage','users.resetPassword':'users.manage',
  'departments.list':'departments.read','departments.create':'departments.manage','departments.update':'departments.manage','departments.deactivate':'departments.manage',
  'roles.list':'roles.read','roles.create':'roles.manage','roles.update':'roles.manage','roles.setPermissions':'roles.manage','permissions.list':'roles.read',
  'books.incoming.list':'incoming.read','books.incoming.get':'incoming.read','books.incoming.create':'incoming.create','books.incoming.update':'incoming.update','books.incoming.delete':'incoming.delete',
  'books.outgoing.list':'outgoing.read','books.outgoing.get':'outgoing.read','books.outgoing.create':'outgoing.create','books.outgoing.update':'outgoing.update','books.outgoing.delete':'outgoing.delete',
  'assignments.list':'assignments.read','assignments.create':'assignments.manage','assignments.update':'assignments.manage',
  'workflow.list':'workflow.read','workflow.add':'workflow.manage',
  'attachments.list':'attachments.read','attachments.upload':'attachments.upload','attachments.download':'attachments.download','attachments.delete':'attachments.delete',
  'images.upload':'settings.manage','images.list':'settings.read',
  'documentTypes.list':'settings.read','documentTypes.create':'settings.manage','documentTypes.update':'settings.manage',
  'categories.list':'settings.read','categories.create':'settings.manage','categories.update':'settings.manage',
  'reports.summary':'reports.read','reports.registryData':'reports.read','pdf.registryData':'reports.read','pdf.encryptAndStore':'attachments.upload',
  'notifications.list':'profile.read','notifications.markRead':'profile.read',
  'audit.list':'audit.read','downloads.list':'audit.read',
  'settings.get':'settings.read','settings.update':'settings.manage',
  'backup.create':'backup.manage','backup.list':'backup.manage','backup.restore':'backup.manage','system.status':'system.read'
};

var DEFAULT_PERMISSIONS = [
  ['profile.read','ดูข้อมูลโปรไฟล์','profile'],['agencies.read','ดูข้อมูลหน่วยงาน','agencies'],['agencies.manage','จัดการหน่วยงาน','agencies'],
  ['users.read','ดูผู้ใช้งาน','users'],['users.manage','จัดการผู้ใช้งาน','users'],
  ['departments.read','ดูฝ่ายและกลุ่มงาน','departments'],['departments.manage','จัดการฝ่ายและกลุ่มงาน','departments'],
  ['roles.read','ดูบทบาทและสิทธิ์','roles'],['roles.manage','จัดการบทบาทและสิทธิ์','roles'],
  ['incoming.read','ดูทะเบียนหนังสือรับ','incoming'],['incoming.create','เพิ่มหนังสือรับ','incoming'],['incoming.update','แก้ไขหนังสือรับ','incoming'],['incoming.delete','ยกเลิกหนังสือรับ','incoming'],
  ['outgoing.read','ดูทะเบียนหนังสือส่ง','outgoing'],['outgoing.create','เพิ่มหนังสือส่ง','outgoing'],['outgoing.update','แก้ไขหนังสือส่ง','outgoing'],['outgoing.delete','ยกเลิกหนังสือส่ง','outgoing'],
  ['assignments.read','ดูงานที่ได้รับมอบหมาย','assignments'],['assignments.manage','จัดการการมอบหมายงาน','assignments'],
  ['workflow.read','ดูประวัติการดำเนินงาน','workflow'],['workflow.manage','บันทึกการดำเนินงาน','workflow'],
  ['attachments.read','ดูไฟล์แนบ','attachments'],['attachments.upload','อัปโหลดไฟล์แนบ','attachments'],['attachments.download','ดาวน์โหลดไฟล์แนบ','attachments'],['attachments.delete','ยกเลิกไฟล์แนบ','attachments'],
  ['reports.read','ดูรายงานและสถิติ','reports'],['audit.read','ดูประวัติการตรวจสอบ','audit'],
  ['settings.read','ดูการตั้งค่า','settings'],['settings.manage','จัดการการตั้งค่า','settings'],['backup.manage','สำรองและกู้คืนข้อมูล','backup'],['system.read','ดูสถานะระบบ','system']
];

/* ========================================================================== */
/* 04. WEB APP ENTRY POINTS AND API ROUTER                                    */
/* ========================================================================== */
function doGet(e) {
  var action = e && e.parameter ? String(e.parameter.action || 'health') : 'health';
  if (action !== 'health') return jsonOutput_({ok:false,code:'GET_NOT_SUPPORTED',message:'ใช้ POST API ผ่าน API Gateway เท่านั้น'});
  return jsonOutput_({ok:true,code:'OK',data:{name:APP.NAME,version:APP.VERSION,service:'Google Apps Script API',timestamp:nowIso_()}});
}

function doPost(e) {
  var requestId = generateId_('req');
  try {
    var rawBody = e && e.postData ? String(e.postData.contents || '') : '';
    if (!rawBody) throw apiError_('EMPTY_REQUEST','ไม่พบข้อมูลคำขอ');
    if (rawBody.length > APP.MAX_REQUEST_BYTES) throw apiError_('REQUEST_TOO_LARGE','คำขอมีขนาดใหญ่เกินกำหนด');
    var envelope;
    try { envelope = JSON.parse(rawBody); } catch (parseError) { throw apiError_('INVALID_JSON','รูปแบบคำขอไม่ถูกต้อง'); }
    verifyGateway_(envelope);
    var payload = envelope.payload || {};
    var action = String(payload.action || '').trim();
    var data = payload.data && typeof payload.data === 'object' ? payload.data : {};
    if (!action) throw apiError_('ACTION_REQUIRED','ต้องระบุ action');
    var context = {
      requestId:requestId,secureRandomHex:String(envelope.secureRandomHex || ''),
      timestamp:Number(envelope.timestamp || 0),nonce:String(envelope.nonce || ''),
      userAgent:String(payload.userAgent || ''),ipHint:String(payload.ipHint || ''),agencyId:String(data.agencyId||'')
    };
    var result = dispatchApi_(action,data,payload.token || '',context);
    return jsonOutput_({ok:true,code:'OK',data:result === undefined ? null : result,requestId:requestId,timestamp:nowIso_()});
  } catch (err) {
    var code = err && err.apiCode ? err.apiCode : 'INTERNAL_ERROR';
    var message = err && err.apiMessage ? err.apiMessage : 'ระบบไม่สามารถดำเนินการได้ กรุณาลองใหม่อีกครั้ง';
    if (code === 'INTERNAL_ERROR') console.error('API error ['+requestId+']: '+(err && err.stack ? err.stack : err));
    return jsonOutput_({ok:false,code:code,message:message,requestId:requestId,timestamp:nowIso_()});
  }
}

function dispatchApi_(action,data,token,context) {
  switch (action) {
    case 'health': return {name:APP.NAME,version:APP.VERSION,timestamp:nowIso_()};
    case 'public.agencyLookup': return publicAgencyLookup_(data);
    case 'auth.login': return login_(data,context);
    case 'auth.logout': return logout_(token,context);
    case 'auth.me': return authMe_(token,context);
    case 'auth.changePassword': return changePassword_(token,data,context);
    case 'auth.updateProfile': return updateOwnProfile_(token,data,context);
    case 'auth.requestPasswordReset': return requestPasswordReset_(data,context);
    case 'auth.resetPassword': return resetPassword_(data,context);
    default: break;
  }
  var user = requireSession_(token);
  var agencyId = String(data.agencyId || user.agency_id || '');
  var permission = ACTION_PERMISSIONS[action];
  if (!permission) throw apiError_('UNKNOWN_ACTION','ไม่รู้จักคำสั่งนี้');
  assertPermission_(user,permission,agencyId);
  if (agencyId && agencyId !== '*' && !isTrue_(user.is_super_admin) && agencyId !== user.agency_id) throw apiError_('AGENCY_FORBIDDEN','ไม่มีสิทธิ์เข้าถึงข้อมูลหน่วยงานนี้');

  switch (action) {
    case 'system.status': return getSystemStatus_(user);
    case 'search.global': return globalSearch_(user,data);
    case 'reports.globalSummary': requireSuperAdmin_(user); return getGlobalReportSummary_(data);
    case 'agencies.list': return listAgencies_(user,data);
    case 'agencies.get': return getAgency_(user,data);
    case 'agencies.create': return createAgency_(user,data,context);
    case 'agencies.update': return updateAgency_(user,data,context);
    case 'agencies.deactivate': return deactivateAgency_(user,data,context);
    case 'users.list': return listUsers_(user,data);
    case 'users.get': return getUser_(user,data);
    case 'users.create': return createUser_(user,data,context);
    case 'users.update': return updateUser_(user,data,context);
    case 'users.deactivate': return deactivateUser_(user,data,context);
    case 'users.resetPassword': return adminResetUserPassword_(user,data,context);
    case 'departments.list': return listDepartments_(user,data);
    case 'departments.create': return createDepartment_(user,data,context);
    case 'departments.update': return updateDepartment_(user,data,context);
    case 'departments.deactivate': return deactivateDepartment_(user,data,context);
    case 'roles.list': return listRoles_(user,data);
    case 'roles.create': return createRole_(user,data,context);
    case 'roles.update': return updateRole_(user,data,context);
    case 'roles.setPermissions': return setRolePermissions_(user,data,context);
    case 'permissions.list': return listPermissions_();
    case 'books.incoming.list': return listBooks_('IncomingBooks',user,data);
    case 'books.incoming.get': return getBook_('IncomingBooks',user,data);
    case 'books.incoming.create': return createBook_('IncomingBooks',user,data,context);
    case 'books.incoming.update': return updateBook_('IncomingBooks',user,data,context);
    case 'books.incoming.delete': return deleteBook_('IncomingBooks',user,data,context);
    case 'books.outgoing.list': return listBooks_('OutgoingBooks',user,data);
    case 'books.outgoing.get': return getBook_('OutgoingBooks',user,data);
    case 'books.outgoing.create': return createBook_('OutgoingBooks',user,data,context);
    case 'books.outgoing.update': return updateBook_('OutgoingBooks',user,data,context);
    case 'books.outgoing.delete': return deleteBook_('OutgoingBooks',user,data,context);
    case 'assignments.list': return listAssignments_(user,data);
    case 'assignments.create': return createAssignment_(user,data,context);
    case 'assignments.update': return updateAssignment_(user,data,context);
    case 'workflow.list': return listWorkflow_(user,data);
    case 'workflow.add': return addWorkflow_(user,data,context);
    case 'attachments.list': return listAttachments_(user,data);
    case 'attachments.upload': return uploadAttachment_(user,data,context);
    case 'attachments.download': return downloadAttachment_(user,data,context);
    case 'attachments.delete': return deleteAttachment_(user,data,context);
    case 'images.upload': return uploadImage_(user,data,context);
    case 'images.list': return listImages_(user,data);
    case 'documentTypes.list': return listLookupItems_('DocumentTypes',user,data);
    case 'documentTypes.create': return createLookupItem_('DocumentTypes',user,data,context);
    case 'documentTypes.update': return updateLookupItem_('DocumentTypes',user,data,context);
    case 'categories.list': return listLookupItems_('BookCategories',user,data);
    case 'categories.create': return createLookupItem_('BookCategories',user,data,context);
    case 'categories.update': return updateLookupItem_('BookCategories',user,data,context);
    case 'reports.summary': return getReportSummary_(user,data);
    case 'reports.registryData': return getRegistryReportData_(user,data);
    case 'pdf.registryData': return getRegistryReportData_(user,data);
    case 'pdf.encryptAndStore': return encryptAndStorePdf_(user,data,context);
    case 'notifications.list': return listNotifications_(user,data);
    case 'notifications.markRead': return markNotificationRead_(user,data,context);
    case 'audit.list': return listAuditLogs_(user,data);
    case 'downloads.list': return listDownloadLogs_(user,data);
    case 'settings.get': return getAgencySettings_(user,data);
    case 'settings.update': return updateAgencySettings_(user,data,context);
    case 'backup.create': return createBackup_(user,data,context);
    case 'backup.list': return listBackups_(user,data);
    case 'backup.restore': return restoreBackup_(user,data,context);
    default: throw apiError_('UNKNOWN_ACTION','ไม่รู้จักคำสั่งนี้');
  }
}

/* ========================================================================== */
/* 05. INITIALIZATION AND AUTOMATIC TABLE CREATION                            */
/* ========================================================================== */
function initializeSystem() {
  var props = PropertiesService.getScriptProperties();
  var pepper=String(props.getProperty(PROP.PASSWORD_PEPPER)||''),gatewaySecret=String(props.getProperty(PROP.GATEWAY_SHARED_SECRET)||'');
  if(pepper.length<32)throw new Error('กรุณากำหนด Script Property PASSWORD_PEPPER ความยาวอย่างน้อย 32 ตัวอักษร');
  if(gatewaySecret.length<32)throw new Error('กรุณากำหนด Script Property GATEWAY_SHARED_SECRET ความยาวอย่างน้อย 32 ตัวอักษร');
  var spreadsheetId = props.getProperty(PROP.SPREADSHEET_ID);
  var ss = spreadsheetId ? SpreadsheetApp.openById(spreadsheetId) : SpreadsheetApp.create('ฐานข้อมูลระบบทะเบียนรับ-ส่งหนังสือ');
  if (!spreadsheetId) props.setProperty(PROP.SPREADSHEET_ID,ss.getId());
  if(!ss.getSheetByName('SystemConfig')) { var defaultSheet=ss.getSheetByName('Sheet1'); if(defaultSheet) defaultSheet.setName('SystemConfig'); }
  ensureAllSheets_(ss);
  ensureRootDriveFolder_();
  seedSystemConfig_();
  seedPermissionsAndRoles_();
  seedLookupDefaults_();
  var existingSuperAdmin=findOne_('Users',function(r){return isTrue_(r.is_super_admin)&&!r.deleted_at;});
  if(!existingSuperAdmin){bootstrapSuperAdmin_();existingSuperAdmin=findOne_('Users',function(r){return isTrue_(r.is_super_admin)&&!r.deleted_at;});}
  if(!existingSuperAdmin)throw new Error('ไม่พบ Super Admin กรุณากำหนด BOOTSTRAP_ADMIN_USERNAME และ BOOTSTRAP_ADMIN_PASSWORD ก่อนรัน initializeSystem()');
  props.setProperty(PROP.SYSTEM_INITIALIZED,'true');
  var result = {ok:true,spreadsheetId:ss.getId(),spreadsheetUrl:ss.getUrl(),driveRootFolderId:props.getProperty(PROP.DRIVE_ROOT_FOLDER_ID),sheets:Object.keys(DB_SCHEMA),initializedAt:nowIso_()};
  Logger.log(JSON.stringify(result,null,2));
  return result;
}
function setupDatabase() { return initializeSystem(); }

function validateConfiguration() {
  var p=PropertiesService.getScriptProperties();
  var hasAdmin=false;try{hasAdmin=!!findOne_('Users',function(r){return isTrue_(r.is_super_admin)&&!r.deleted_at;});}catch(ignore){}
  var checks={spreadsheetId:!!p.getProperty(PROP.SPREADSHEET_ID),passwordPepper:!!(p.getProperty(PROP.PASSWORD_PEPPER)&&p.getProperty(PROP.PASSWORD_PEPPER).length>=32),gatewaySecret:!!(p.getProperty(PROP.GATEWAY_SHARED_SECRET)&&p.getProperty(PROP.GATEWAY_SHARED_SECRET).length>=32),bootstrapUsername:!!p.getProperty(PROP.BOOTSTRAP_ADMIN_USERNAME),bootstrapPassword:!!p.getProperty(PROP.BOOTSTRAP_ADMIN_PASSWORD),superAdminExists:hasAdmin,imgbbApiKey:!!p.getProperty(PROP.IMGBB_API_KEY),pdfEncryptionEndpoint:!!p.getProperty(PROP.PDF_ENCRYPTION_ENDPOINT),pdfEncryptionApiKey:!!p.getProperty(PROP.PDF_ENCRYPTION_API_KEY),appBaseUrl:!!p.getProperty(PROP.APP_BASE_URL),driveRootFolderId:!!p.getProperty(PROP.DRIVE_ROOT_FOLDER_ID)};
  return {checks:checks,readyForInitialize:checks.passwordPepper&&checks.gatewaySecret&&(checks.superAdminExists||(checks.bootstrapUsername&&checks.bootstrapPassword)),readyForApi:checks.gatewaySecret&&checks.spreadsheetId,readyForImageUpload:checks.imgbbApiKey,readyForPasswordProtectedPdf:checks.pdfEncryptionEndpoint&&checks.pdfEncryptionApiKey};
}

function ensureAllSheets_(ss) {
  Object.keys(DB_SCHEMA).forEach(function(name){ensureSheetSchema_(ss,name,DB_SCHEMA[name]);});
}
function ensureSheetSchema_(ss,name,expectedHeaders) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  var lastColumn = sheet.getLastColumn();
  var existing = lastColumn > 0 && sheet.getLastRow() >= 1 ? sheet.getRange(1,1,1,lastColumn).getValues()[0].map(function(v){return String(v||'').trim();}) : [];
  if (!existing.length || existing.every(function(h){return !h;})) {
    sheet.getRange(1,1,1,expectedHeaders.length).setValues([expectedHeaders]);
  } else {
    var missing = expectedHeaders.filter(function(h){return existing.indexOf(h) === -1;});
    if (missing.length) sheet.getRange(1,Math.max(sheet.getLastColumn(),existing.length)+1,1,missing.length).setValues([missing]);
  }
  var cols = sheet.getLastColumn();
  sheet.setFrozenRows(1);
  sheet.getRange(1,1,1,cols).setBackground(APP.SHEET_HEADER_COLOR).setFontColor(APP.SHEET_HEADER_FONT_COLOR).setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  sheet.setRowHeight(1,34);
  if (cols && !sheet.getFilter()) sheet.getRange(1,1,Math.max(sheet.getLastRow(),1),cols).createFilter();
  return sheet;
}

function seedSystemConfig_() {
  var rows = [
    ['system_name',APP.NAME,'string','general','ชื่อระบบ','true'],['system_version',APP.VERSION,'string','general','เวอร์ชันระบบ','true'],
    ['timezone',APP.TIMEZONE,'string','general','เขตเวลาเริ่มต้น','true'],['session_ttl_seconds',String(APP.SESSION_TTL_SECONDS),'number','security','อายุ Session เป็นวินาที','false'],
    ['max_upload_bytes',String(APP.MAX_UPLOAD_BYTES),'number','files','ขนาดไฟล์อัปโหลดสูงสุดเป็นไบต์','false'],['fiscal_year_start_month','10','number','registry','เดือนเริ่มต้นปีงบประมาณ','false'],
    ['pdf_font_family','TH Sarabun New','string','pdf','ฟอนต์ PDF','true'],['pdf_orientation','landscape','string','pdf','แนวกระดาษ PDF','true'],
    ['pdf_paper_size','A4','string','pdf','ขนาดกระดาษ PDF','true'],['pdf_encryption_algorithm','AES-256','string','security','อัลกอริทึมเข้ารหัส PDF','false'],
    ['priority_levels_json',JSON.stringify(['ปกติ','ด่วน','ด่วนมาก','ด่วนที่สุด']),'json','registry','ระดับความเร็ว','true'],
    ['confidentiality_levels_json',JSON.stringify(['ปกติ','ลับ','ลับมาก','ลับที่สุด']),'json','registry','ชั้นความลับ','true']
  ];
  var now = nowIso_();
  rows.forEach(function(r){upsertByField_('SystemConfig','config_key',r[0],{config_key:r[0],config_value:r[1],value_type:r[2],category:r[3],description:r[4],is_public:r[5],created_at:now,updated_at:now,updated_by:'SYSTEM'});});
}

function seedPermissionsAndRoles_() {
  var now = nowIso_();
  DEFAULT_PERMISSIONS.forEach(function(p){upsertByField_('Permissions','permission_code',p[0],{permission_id:'perm_'+slug_(p[0]),permission_code:p[0],permission_name:p[1],permission_group:p[2],permission_description:p[1],created_at:now});});
  var seeds = [
    ['SUPER_ADMIN','ผู้ดูแลระบบส่วนกลาง','จัดการทุกหน่วยงานและทุกฟังก์ชัน'],['AGENCY_ADMIN','ผู้ดูแลหน่วยงาน','จัดการข้อมูลทั้งหมดภายในหน่วยงาน'],
    ['REGISTRAR','เจ้าหน้าที่สารบรรณ','จัดการทะเบียนรับและทะเบียนส่ง'],['DEPARTMENT_HEAD','หัวหน้าฝ่าย','ตรวจสอบ มอบหมาย และติดตามงาน'],
    ['EXECUTIVE','ผู้บริหาร','ตรวจสอบและติดตามการดำเนินงาน'],['STAFF','เจ้าหน้าที่ทั่วไป','ดูและดำเนินการตามสิทธิ์ที่ได้รับ'],['AUDITOR','ผู้ตรวจสอบ','ดูข้อมูลและประวัติสำหรับตรวจสอบ']
  ];
  seeds.forEach(function(r){var id='role_'+slug_(r[0].toLowerCase());upsertByField_('Roles','role_code',r[0],{role_id:id,agency_id:'*',role_code:r[0],role_name:r[1],role_description:r[2],is_system_role:'true',is_active:'true',created_by:'SYSTEM',created_at:now,updated_by:'SYSTEM',updated_at:now});});
  var perms = {
    SUPER_ADMIN:['*'],AGENCY_ADMIN:['*'],
    REGISTRAR:['profile.read','incoming.read','incoming.create','incoming.update','outgoing.read','outgoing.create','outgoing.update','assignments.read','assignments.manage','workflow.read','workflow.manage','attachments.read','attachments.upload','attachments.download','reports.read','settings.read'],
    DEPARTMENT_HEAD:['profile.read','incoming.read','incoming.update','outgoing.read','outgoing.update','assignments.read','assignments.manage','workflow.read','workflow.manage','attachments.read','attachments.upload','attachments.download','reports.read'],
    EXECUTIVE:['profile.read','incoming.read','outgoing.read','assignments.read','workflow.read','attachments.read','attachments.download','reports.read'],
    STAFF:['profile.read','incoming.read','outgoing.read','assignments.read','workflow.read','attachments.read','attachments.upload','attachments.download'],
    AUDITOR:['profile.read','incoming.read','outgoing.read','assignments.read','workflow.read','attachments.read','reports.read','audit.read']
  };
  Object.keys(perms).forEach(function(code){var roleId='role_'+slug_(code.toLowerCase());perms[code].forEach(function(permission){var key=roleId+'|'+permission+'|*';upsertByField_('RolePermissions','role_permission_id',key,{role_permission_id:key,role_id:roleId,permission_code:permission,agency_id:'*',created_by:'SYSTEM',created_at:now});});});
}

function seedLookupDefaults_() {
  var now=nowIso_();
  [['EXT','หนังสือภายนอก'],['INT','หนังสือภายใน'],['MEMO','บันทึกข้อความ'],['ORDER','คำสั่ง'],['ANNOUNCEMENT','ประกาศ'],['REGULATION','ระเบียบ'],['CIRCULAR','หนังสือเวียน'],['CERTIFICATE','หนังสือรับรอง'],['OTHER','อื่น ๆ']].forEach(function(r,i){
    upsertByField_('DocumentTypes','type_code',r[0],{document_type_id:'doctype_'+slug_(r[0].toLowerCase()),agency_id:'*',type_code:r[0],type_name:r[1],description:'',default_prefix:'',sort_order:i+1,is_active:'true',created_by:'SYSTEM',created_at:now,updated_by:'SYSTEM',updated_at:now});
  });
  [['GENERAL','ทั่วไป'],['ADMIN','งานบริหาร'],['FINANCE','การเงินและงบประมาณ'],['PERSONNEL','งานบุคคล'],['PROCUREMENT','พัสดุและจัดซื้อจัดจ้าง'],['LEGAL','กฎหมายและระเบียบ'],['MEETING','การประชุม'],['OTHER','อื่น ๆ']].forEach(function(r,i){
    upsertByField_('BookCategories','category_code',r[0],{category_id:'category_'+slug_(r[0].toLowerCase()),agency_id:'*',category_code:r[0],category_name:r[1],description:'',sort_order:i+1,is_active:'true',created_by:'SYSTEM',created_at:now,updated_by:'SYSTEM',updated_at:now});
  });
}

function bootstrapSuperAdmin_() {
  var props=PropertiesService.getScriptProperties();
  var username=String(props.getProperty(PROP.BOOTSTRAP_ADMIN_USERNAME)||'').trim();
  var password=String(props.getProperty(PROP.BOOTSTRAP_ADMIN_PASSWORD)||'');
  if(!username||!password)return {created:false,reason:'Bootstrap credentials not configured'};
  if(!/^[a-z0-9._-]{3,64}$/i.test(username))throw new Error('BOOTSTRAP_ADMIN_USERNAME ต้องมี 3–64 ตัว ใช้ตัวอักษร ตัวเลข จุด ขีด หรือขีดล่าง');
  validateNewPassword_(password);
  var existing=findOne_('Users',function(r){return String(r.username).toLowerCase()===username.toLowerCase()&&isTrue_(r.is_super_admin);});
  if(existing)return {created:false,reason:'Super Admin already exists'};
  var salt=uuidHex_(),now=nowIso_();
  var record={user_id:generateId_('usr'),agency_id:'*',username:username,password_hash:hashPassword_(password,salt,null).hash,password_salt:salt,password_algorithm:'PBKDF2-HMAC-SHA256',password_iterations:APP.PBKDF2_ITERATIONS,display_name:'Super Admin',first_name:'Super',last_name:'Admin',email:String(props.getProperty(PROP.BOOTSTRAP_ADMIN_EMAIL)||''),phone:'',position:'System Administrator',department_id:'',role_id:'role_super_admin',is_super_admin:'true',status:'ACTIVE',must_change_password:true,failed_login_count:0,locked_until:'',last_login_at:'',last_password_change_at:now,avatar_url:'',notification_preferences_json:'{}',created_by:'SYSTEM',created_at:now,updated_by:'SYSTEM',updated_at:now,deleted_at:''};
  appendRecord_('Users',record);
  props.deleteProperty(PROP.BOOTSTRAP_ADMIN_PASSWORD);
  return {created:true,userId:record.user_id};
}

/* ========================================================================== */
/* 06. SIGNED GATEWAY VERIFICATION                                            */
/* ========================================================================== */
function verifyGateway_(envelope) {
  var props=PropertiesService.getScriptProperties();
  var secret=props.getProperty(PROP.GATEWAY_SHARED_SECRET);
  var allowDirect=String(props.getProperty(PROP.ALLOW_DIRECT_API)||'').toLowerCase()==='true';
  if(!secret&&allowDirect)return true;
  if(!secret)throw apiError_('GATEWAY_NOT_CONFIGURED','ยังไม่ได้ตั้งค่า API Gateway Secret');
  if(!envelope||typeof envelope!=='object')throw apiError_('INVALID_GATEWAY_ENVELOPE','รูปแบบ Gateway ไม่ถูกต้อง');
  var timestamp=Number(envelope.timestamp||0),nonce=String(envelope.nonce||''),randomHex=String(envelope.secureRandomHex||''),payload=envelope.payload||{},signature=String(envelope.signature||'');
  if(!timestamp||!nonce||!signature||!payload.action)throw apiError_('INVALID_GATEWAY_ENVELOPE','ข้อมูลยืนยัน Gateway ไม่ครบถ้วน');
  if(Math.abs(Math.floor(Date.now()/1000)-timestamp)>APP.GATEWAY_CLOCK_SKEW_SECONDS)throw apiError_('GATEWAY_TIMESTAMP_EXPIRED','คำขอหมดอายุ กรุณาลองใหม่');
  if(!/^[A-Za-z0-9_-]{12,160}$/.test(nonce))throw apiError_('INVALID_GATEWAY_NONCE','Nonce ไม่ถูกต้อง');
  if(!/^[a-fA-F0-9]{512,4096}$/.test(randomHex))throw apiError_('SECURE_RANDOM_REQUIRED','Gateway ต้องส่ง secureRandomHex จาก crypto.getRandomValues');
  var canonical=timestamp+'\n'+nonce+'\n'+randomHex.toLowerCase()+'\n'+JSON.stringify(payload);
  var expected=Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(canonical,secret,Utilities.Charset.UTF_8)).replace(/=+$/g,'');
  if(!constantTimeEquals_(expected,signature.replace(/=+$/g,'')))throw apiError_('GATEWAY_SIGNATURE_INVALID','ลายเซ็น Gateway ไม่ถูกต้อง');
  // Cache is a short-term replay barrier; the API Gateway must also persistently reject reused nonces.
  var cache=CacheService.getScriptCache(),key='api_nonce_'+sha256Hex_(nonce);
  if(cache.get(key))throw apiError_('GATEWAY_REPLAY_BLOCKED','ตรวจพบคำขอซ้ำ');
  cache.put(key,'1',APP.GATEWAY_NONCE_TTL_SECONDS);
  return true;
}
function jsonOutput_(object){return ContentService.createTextOutput(JSON.stringify(object)).setMimeType(ContentService.MimeType.JSON);}
function apiError_(code,message){var error=new Error(message||code);error.apiCode=code;error.apiMessage=message||code;return error;}

/* ========================================================================== */
/* 07. AUTHENTICATION, PASSWORDS, SESSIONS AND PASSWORD RESET                 */
/* ========================================================================== */
function publicAgencyLookup_(data) {
  requireDatabase_();
  var code=String(data.agencyCode||'').trim().toUpperCase();
  if(!code)throw apiError_('AGENCY_CODE_REQUIRED','กรุณาระบุรหัสหน่วยงาน');
  if(code==='SYSTEM')return {agencyId:'*',agencyCode:'SYSTEM',agencyName:APP.NAME,shortName:'ส่วนกลาง',logoUrl:'',status:'ACTIVE'};
  var rows=readTable_('Agencies').filter(function(r){return String(r.agency_code).toUpperCase()===code&&r.status==='ACTIVE'&&!r.deleted_at;});
  if(!rows.length)throw apiError_('AGENCY_NOT_FOUND','ไม่พบรหัสหน่วยงานหรือหน่วยงานไม่ได้เปิดใช้งาน');
  var a=rows[0];
  return {agencyId:a.agency_id,agencyCode:a.agency_code,agencyName:a.agency_name,shortName:a.agency_short_name||'',logoUrl:a.logo_url||'',status:a.status};
}

function login_(data,context) {
  requireDatabase_();
  var code=String(data.agencyCode||'').trim().toUpperCase();
  var username=String(data.username||'').trim().toLowerCase();
  var password=String(data.password||'');
  if(!code||!username||!password)throw apiError_('LOGIN_FIELDS_REQUIRED','กรุณากรอกรหัสหน่วยงาน ชื่อผู้ใช้ และรหัสผ่านให้ครบถ้วน');
  var agency;
  if(code==='SYSTEM')agency={agency_id:'*',agency_code:'SYSTEM',agency_name:APP.NAME,agency_short_name:'ส่วนกลาง',logo_url:'',status:'ACTIVE'};
  else {
    var agencyRows=readTable_('Agencies').filter(function(r){return String(r.agency_code).toUpperCase()===code&&r.status==='ACTIVE'&&!r.deleted_at;});
    if(!agencyRows.length){recordLoginAttempt_(code,username,false,'AGENCY_NOT_FOUND',context);throw apiError_('LOGIN_FAILED','ข้อมูลเข้าสู่ระบบไม่ถูกต้อง');}
    agency=agencyRows[0];
  }
  var userRows=readTable_('Users').filter(function(r){
    return String(r.username).toLowerCase()===username&&(String(r.agency_id)===String(agency.agency_id)||(isTrue_(r.is_super_admin)&&String(r.agency_id)==='*'))&&!r.deleted_at;
  });
  if(!userRows.length){recordLoginAttempt_(code,username,false,'USER_NOT_FOUND',context);throw apiError_('LOGIN_FAILED','ข้อมูลเข้าสู่ระบบไม่ถูกต้อง');}
  var user=userRows[0];
  if(String(user.status).toUpperCase()!=='ACTIVE')throw apiError_('ACCOUNT_DISABLED','บัญชีนี้ถูกระงับการใช้งาน');
  if(user.locked_until&&new Date(user.locked_until).getTime()>Date.now())throw apiError_('ACCOUNT_LOCKED','บัญชีถูกล็อกชั่วคราวเนื่องจากเข้าสู่ระบบไม่สำเร็จหลายครั้ง');
  if(!verifyPassword_(password,user.password_salt,user.password_hash,Number(user.password_iterations)||APP.PBKDF2_ITERATIONS)){
    var count=(Number(user.failed_login_count)||0)+1;
    updateRecord_('Users','user_id',user.user_id,{failed_login_count:count,locked_until:count>=APP.LOGIN_MAX_FAILURES?new Date(Date.now()+APP.LOGIN_LOCK_MINUTES*60000).toISOString():''});
    recordLoginAttempt_(code,username,false,'BAD_PASSWORD',context);
    throw apiError_('LOGIN_FAILED','ข้อมูลเข้าสู่ระบบไม่ถูกต้อง');
  }
  if(user.must_change_password==='TRUE'||isTrue_(user.must_change_password)){recordLoginAttempt_(code,username,true,'PASSWORD_CHANGE_REQUIRED',context);var pendingToken=createSession_(user,agency,context,true);return {token:pendingToken,expiresIn:APP.SESSION_TTL_SECONDS,mustChangePassword:true,agency:publicAgency_(agency),user:publicUser_(user),permissions:getUserPermissionCodes_(user)};}
  updateRecord_('Users','user_id',user.user_id,{failed_login_count:0,locked_until:'',last_login_at:nowIso_()});
  recordLoginAttempt_(code,username,true,'OK',context);
  var token=createSession_(user,agency,context,false);
  writeAudit_(user,'auth.login','authentication','User',user.user_id,'เข้าสู่ระบบสำเร็จ',null,null,context);
  return {token:token,expiresIn:APP.SESSION_TTL_SECONDS,agency:publicAgency_(agency),user:publicUser_(user),permissions:getUserPermissionCodes_(user)};
}

function authMe_(token,context) {
  var user=requireSession_(token),agency=null,session=findOne_('Sessions',function(r){return r.token_hash===sha256Hex_(String(token))&&r.status==='ACTIVE';});
  if(session&&session.agency_id!=='*')agency=getAgencyRecord_(session.agency_id);else if(user.agency_id!=='*')agency=getAgencyRecord_(user.agency_id);
  return {user:publicUser_(user),agency:agency?publicAgency_(agency):null,permissions:getUserPermissionCodes_(user)};
}

function logout_(token,context) {
  if(!token)return {loggedOut:true};
  var hash=sha256Hex_(token),rows=readTable_('Sessions').filter(function(r){return r.token_hash===hash&&r.status==='ACTIVE';});
  if(rows.length)updateRecord_('Sessions','session_id',rows[0].session_id,{status:'REVOKED',revoked_at:nowIso_()});
  CacheService.getScriptCache().remove('session_'+hash);
  return {loggedOut:true};
}

function changePassword_(token,data,context) {
  var user=requireSession_(token),oldPassword=String(data.currentPassword||''),newPassword=String(data.newPassword||'');
  if(!verifyPassword_(oldPassword,user.password_salt,user.password_hash,Number(user.password_iterations)||APP.PBKDF2_ITERATIONS))throw apiError_('CURRENT_PASSWORD_INVALID','รหัสผ่านเดิมไม่ถูกต้อง');
  validateNewPassword_(newPassword);
  var hashed=hashPassword_(newPassword,secureRandomToken_(context,16),context);
  updateRecord_('Users','user_id',user.user_id,{password_hash:hashed.hash,password_salt:hashed.salt,password_algorithm:'PBKDF2-HMAC-SHA256',password_iterations:APP.PBKDF2_ITERATIONS,must_change_password:false,last_password_change_at:nowIso_(),updated_at:nowIso_(),updated_by:user.user_id});
  revokeUserSessions_(user.user_id);
  writeAudit_(user,'auth.changePassword','authentication','User',user.user_id,'เปลี่ยนรหัสผ่าน',null,null,context);
  return {changed:true,loginAgain:true};
}

function requestPasswordReset_(data,context) {
  requireDatabase_();
  var code=String(data.agencyCode||'').trim().toUpperCase(),username=String(data.username||'').trim().toLowerCase();
  var generic={accepted:true,message:'หากพบข้อมูลบัญชี ระบบจะส่งขั้นตอนการตั้งรหัสผ่านไปยังอีเมลที่ลงทะเบียน'};
  var configuredBaseUrl=String(PropertiesService.getScriptProperties().getProperty(PROP.APP_BASE_URL)||'').trim();
  // Do not issue reset tokens until the production GitHub Pages URL is configured.
  if(!/^https:\/\//i.test(configuredBaseUrl))return generic;
  if(!code||!username)return generic;
  var agencyRows=readTable_('Agencies').filter(function(r){return String(r.agency_code).toUpperCase()===code&&r.status==='ACTIVE';});
  if(!agencyRows.length)return generic;
  var a=agencyRows[0],users=readTable_('Users').filter(function(r){return r.agency_id===a.agency_id&&String(r.username).toLowerCase()===username&&r.status==='ACTIVE'&&!r.deleted_at;});
  if(!users.length||!users[0].email)return generic;
  readTable_('PasswordResetTokens').filter(function(r){return r.user_id===users[0].user_id&&r.status==='ACTIVE'&&!r.used_at;}).forEach(function(r){updateRecord_('PasswordResetTokens','reset_id',r.reset_id,{status:'REVOKED'});});
  var rawToken=secureRandomToken_(context,32),tokenHash=sha256Hex_(rawToken),u=users[0],resetId=generateId_('rst'),expires=new Date(Date.now()+APP.PASSWORD_RESET_TTL_MINUTES*60000).toISOString();
  appendRecord_('PasswordResetTokens',{reset_id:resetId,user_id:u.user_id,agency_id:u.agency_id,token_hash:tokenHash,created_at:nowIso_(),expires_at:expires,used_at:'',status:'ACTIVE'});
  var link=configuredBaseUrl.replace(/\/$/,'')+'/index.html#resetToken='+encodeURIComponent(rawToken)+'&agency='+encodeURIComponent(code);
  try{MailApp.sendEmail({to:u.email,subject:'ตั้งรหัสผ่านใหม่ - '+a.agency_name,htmlBody:'<p>มีคำขอตั้งรหัสผ่านใหม่สำหรับบัญชีของคุณ</p><p><a href="'+escapeHtml_(link)+'">ตั้งรหัสผ่านใหม่</a></p><p>ลิงก์หมดอายุภายใน '+APP.PASSWORD_RESET_TTL_MINUTES+' นาที หากไม่ได้ร้องขอสามารถละเว้นอีเมลฉบับนี้ได้</p>',name:PropertiesService.getScriptProperties().getProperty(PROP.MAIL_FROM_NAME)||APP.NAME});}catch(mailError){console.error('Password reset email failed: '+mailError);}
  return generic;
}

function resetPassword_(data,context) {
  var raw=String(data.resetToken||''),newPassword=String(data.newPassword||'');
  if(!raw)throw apiError_('RESET_TOKEN_REQUIRED','ไม่พบ Token สำหรับตั้งรหัสผ่านใหม่');
  validateNewPassword_(newPassword);
  var tokenHash=sha256Hex_(raw),rows=readTable_('PasswordResetTokens').filter(function(r){return r.token_hash===tokenHash&&r.status==='ACTIVE'&&!r.used_at&&new Date(r.expires_at).getTime()>Date.now();});
  if(!rows.length)throw apiError_('RESET_TOKEN_INVALID','ลิงก์ตั้งรหัสผ่านไม่ถูกต้องหรือหมดอายุแล้ว');
  var reset=rows[0],user=getRecordById_('Users','user_id',reset.user_id);
  if(!user||user.status!=='ACTIVE')throw apiError_('USER_NOT_FOUND','ไม่พบบัญชีผู้ใช้งาน');
  var hashed=hashPassword_(newPassword,secureRandomToken_(context,16),context);
  updateRecord_('Users','user_id',user.user_id,{password_hash:hashed.hash,password_salt:hashed.salt,password_algorithm:'PBKDF2-HMAC-SHA256',password_iterations:APP.PBKDF2_ITERATIONS,must_change_password:false,failed_login_count:0,locked_until:'',last_password_change_at:nowIso_(),updated_at:nowIso_()});
  updateRecord_('PasswordResetTokens','reset_id',reset.reset_id,{status:'USED',used_at:nowIso_()});
  revokeUserSessions_(user.user_id);
  return {reset:true,message:'ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว'};
}

function createSession_(user,agency,context,mustChange) {
  var token=secureRandomToken_(context,32),hash=sha256Hex_(token),now=Date.now(),session={session_id:generateId_('ses'),token_hash:hash,user_id:user.user_id,agency_id:agency.agency_id,issued_at:new Date(now).toISOString(),expires_at:new Date(now+APP.SESSION_TTL_SECONDS*1000).toISOString(),last_seen_at:nowIso_(),revoked_at:'',status:'ACTIVE',user_agent_hint:String(context.userAgent||'').slice(0,180)};
  appendRecord_('Sessions',session);
  CacheService.getScriptCache().put('session_'+hash,JSON.stringify({userId:user.user_id,expiresAt:session.expires_at}),APP.SESSION_TTL_SECONDS);
  return token;
}

function requireSession_(token) {
  if(!token)throw apiError_('AUTH_REQUIRED','กรุณาเข้าสู่ระบบ');
  var hash=sha256Hex_(String(token)),cache=CacheService.getScriptCache(),cached=cache.get('session_'+hash),userId='';
  if(cached){try{userId=JSON.parse(cached).userId;}catch(ignore){userId='';}}
  var sessions=readTable_('Sessions').filter(function(r){return r.token_hash===hash&&r.status==='ACTIVE'&&!r.revoked_at&&new Date(r.expires_at).getTime()>Date.now();});
  if(!sessions.length)throw apiError_('SESSION_EXPIRED','เซสชันหมดอายุหรือถูกยกเลิก กรุณาเข้าสู่ระบบใหม่');
  var session=sessions[0];
  if(userId&&userId!==session.user_id)throw apiError_('SESSION_INVALID','เซสชันไม่ถูกต้อง');
  var user=getRecordById_('Users','user_id',session.user_id);
  if(!user||String(user.status).toUpperCase()!=='ACTIVE'||user.deleted_at)throw apiError_('ACCOUNT_DISABLED','บัญชีนี้ไม่สามารถใช้งานได้');
  var now=Date.now(),exp=new Date(session.expires_at).getTime();
  if(exp-now<APP.SESSION_TTL_SECONDS*500){updateRecord_('Sessions','session_id',session.session_id,{expires_at:new Date(now+APP.SESSION_TTL_SECONDS*1000).toISOString(),last_seen_at:nowIso_()});cache.put('session_'+hash,JSON.stringify({userId:user.user_id}),APP.SESSION_TTL_SECONDS);}
  return user;
}

function revokeUserSessions_(userId) {
  var rows=readTable_('Sessions').filter(function(r){return r.user_id===userId&&r.status==='ACTIVE';});
  rows.forEach(function(r){updateRecord_('Sessions','session_id',r.session_id,{status:'REVOKED',revoked_at:nowIso_()});CacheService.getScriptCache().remove('session_'+r.token_hash);});
}

function hashPassword_(password,providedSalt,context) {
  var pepper=PropertiesService.getScriptProperties().getProperty(PROP.PASSWORD_PEPPER);
  if(!pepper||pepper.length<32)throw apiError_('PASSWORD_PEPPER_NOT_CONFIGURED','ต้องกำหนด PASSWORD_PEPPER อย่างน้อย 32 ตัวอักษรใน Script Properties');
  var salt=String(providedSalt||secureRandomToken_(context,16)),passBytes=Utilities.newBlob(String(password)+pepper).getBytes(),saltBytes=hexToBytes_(salt),u=Utilities.computeHmacSha256Signature(concatBytes_(saltBytes,[0,0,0,1]),passBytes),derived=u.slice();
  for(var i=1;i<APP.PBKDF2_ITERATIONS;i++){u=Utilities.computeHmacSha256Signature(u,passBytes);for(var j=0;j<derived.length;j++)derived[j]=(derived[j]^u[j])&255;}
  return {salt:salt,hash:bytesToHex_(derived)};
}

function verifyPassword_(password,salt,expectedHash,iterations) {
  if(!salt||!expectedHash)return false;
  var pepper=PropertiesService.getScriptProperties().getProperty(PROP.PASSWORD_PEPPER);
  if(!pepper)return false;
  var passBytes=Utilities.newBlob(String(password)+pepper).getBytes(),saltBytes=hexToBytes_(salt),u=Utilities.computeHmacSha256Signature(concatBytes_(saltBytes,[0,0,0,1]),passBytes),derived=u.slice();
  var count=Math.max(10000,Math.min(Number(iterations)||APP.PBKDF2_ITERATIONS,300000));
  for(var i=1;i<count;i++){u=Utilities.computeHmacSha256Signature(u,passBytes);for(var j=0;j<derived.length;j++)derived[j]=(derived[j]^u[j])&255;}
  return constantTimeEquals_(bytesToHex_(derived),String(expectedHash).toLowerCase());
}

function validateNewPassword_(password) {
  if(password.length<APP.PASSWORD_MIN_LENGTH)throw apiError_('PASSWORD_TOO_SHORT','รหัสผ่านใหม่ต้องมีอย่างน้อย '+APP.PASSWORD_MIN_LENGTH+' ตัวอักษร');
  if(password.length>256)throw apiError_('PASSWORD_TOO_LONG','รหัสผ่านยาวเกินกำหนด');
  if(!/[A-Za-z]/.test(password)||!/[0-9]/.test(password))throw apiError_('PASSWORD_COMPLEXITY','รหัสผ่านต้องมีตัวอักษรภาษาอังกฤษและตัวเลขอย่างน้อยอย่างละหนึ่งตัว');
}

function recordLoginAttempt_(agencyCode,username,success,reason,context) {
  appendRecord_('LoginAttempts',{attempt_id:generateId_('lat'),agency_code:agencyCode,username:username,attempted_at:nowIso_(),success:!!success,reason:reason,ip_hint:String(context&&context.ipHint||'').slice(0,80)});
}

function updateOwnProfile_(token,data,context) {
  var user=requireSession_(token),patch={updated_by:user.user_id,updated_at:nowIso_()};
  var fields={displayName:'display_name',firstName:'first_name',lastName:'last_name',email:'email',phone:'phone',position:'position',avatarUrl:'avatar_url'};
  Object.keys(fields).forEach(function(k){if(data[k]!==undefined)patch[fields[k]]=String(data[k]);});
  if(data.notificationPreferences!==undefined)patch.notification_preferences_json=JSON.stringify(data.notificationPreferences);
  updateRecord_('Users','user_id',user.user_id,patch);writeAudit_(user,'auth.updateProfile','profile','User',user.user_id,'แก้ไขโปรไฟล์',null,patch,context);return publicUser_(getRecordById_('Users','user_id',user.user_id));
}

/* ========================================================================== */
/* 08. AGENCY MANAGEMENT                                                      */
/* ========================================================================== */
function listAgencies_(user,data) {
  var rows=readTable_('Agencies').filter(function(r){return !r.deleted_at&&(isTrue_(data.includeInactive)||r.status==='ACTIVE');});
  if(!isTrue_(user.is_super_admin))rows=rows.filter(function(r){return r.agency_id===user.agency_id;});
  return paginate_(rows,data).map(publicAgency_);
}
function getAgency_(user,data) {var a=getAgencyRecord_(data.agencyId||user.agency_id);if(!a||a.deleted_at)throw apiError_('AGENCY_NOT_FOUND','ไม่พบหน่วยงาน');return publicAgency_(a);}

function createAgency_(user,data,context) {
  requireSuperAdmin_(user);
  var code=String(data.agencyCode||'').trim().toUpperCase(),name=String(data.agencyName||'').trim();
  if(!/^[A-Z0-9_-]{3,24}$/.test(code))throw apiError_('INVALID_AGENCY_CODE','รหัสหน่วยงานต้องมี 3–24 ตัว ใช้ A-Z, 0-9, _ หรือ -');
  if(!name)throw apiError_('AGENCY_NAME_REQUIRED','กรุณาระบุชื่อหน่วยงาน');
  if(readTable_('Agencies').some(function(r){return String(r.agency_code).toUpperCase()===code;}))throw apiError_('AGENCY_CODE_EXISTS','รหัสหน่วยงานนี้มีแล้ว');
  var agencyId=generateId_('agy'),folder=ensureAgencyDriveFolders_(agencyId,name),now=nowIso_();
  var a={agency_id:agencyId,agency_code:code,agency_name:name,agency_short_name:String(data.shortName||''),agency_type:String(data.agencyType||'GOVERNMENT'),parent_agency_id:String(data.parentAgencyId||''),logo_url:String(data.logoUrl||''),address:String(data.address||''),village:String(data.village||''),building:String(data.building||''),street:String(data.street||''),subdistrict:String(data.subdistrict||''),district:String(data.district||''),province:String(data.province||''),postal_code:String(data.postalCode||''),phone:String(data.phone||''),fax:String(data.fax||''),email:String(data.email||''),website:String(data.website||''),timezone:'Asia/Bangkok',fiscal_year_start_month:Number(data.fiscalYearStartMonth)||10,incoming_prefix:String(data.incomingPrefix||'รับ'),outgoing_prefix:String(data.outgoingPrefix||'ส่ง'),current_fiscal_year:getFiscalYearForAgency_(today_(),{fiscal_year_start_month:Number(data.fiscalYearStartMonth)||10}),drive_folder_id:folder.root,status:'ACTIVE',settings_json:JSON.stringify(data.settings||{}),created_by:user.user_id,created_at:now,updated_by:user.user_id,updated_at:now,deleted_at:''};
  appendRecord_('Agencies',a);ensureAgencyDefaultRole_(agencyId,user.user_id);writeAudit_(user,'agencies.create','agencies','Agency',agencyId,'เพิ่มหน่วยงาน '+name,null,a,context);
  return publicAgency_(a);
}

function updateAgency_(user,data,context) {
  var id=String(data.agencyId||user.agency_id),old=getAgencyRecord_(id);if(!old)throw apiError_('AGENCY_NOT_FOUND','ไม่พบหน่วยงาน');assertSameAgencyOrSuper_(user,id);
  if(!isTrue_(user.is_super_admin)&&(data.agencyType!==undefined||data.parentAgencyId!==undefined))throw apiError_('FORBIDDEN','ผู้ดูแลหน่วยงานไม่มีสิทธิ์เปลี่ยนประเภทหรือหน่วยงานแม่');
  var fields={agency_name:'agencyName',agency_short_name:'shortName',agency_type:'agencyType',parent_agency_id:'parentAgencyId',logo_url:'logoUrl',address:'address',village:'village',building:'building',street:'street',subdistrict:'subdistrict',district:'district',province:'province',postal_code:'postalCode',phone:'phone',fax:'fax',email:'email',website:'website',incoming_prefix:'incomingPrefix',outgoing_prefix:'outgoingPrefix'};
  var patch={updated_by:user.user_id,updated_at:nowIso_()};Object.keys(fields).forEach(function(k){if(data[fields[k]]!==undefined)patch[k]=String(data[fields[k]]);});
  if(data.fiscalYearStartMonth!==undefined)patch.fiscal_year_start_month=Number(data.fiscalYearStartMonth);
  if(data.settings!==undefined)patch.settings_json=JSON.stringify(data.settings);
  updateRecord_('Agencies','agency_id',id,patch);writeAudit_(user,'agencies.update','agencies','Agency',id,'แก้ไขข้อมูลหน่วยงาน',old,patch,context);return publicAgency_(getAgencyRecord_(id));
}

function deactivateAgency_(user,data,context) {
  requireSuperAdmin_(user);var id=String(data.agencyId||''),a=getAgencyRecord_(id);if(!a)throw apiError_('AGENCY_NOT_FOUND','ไม่พบหน่วยงาน');
  if(isTrue_(data.permanent))throw apiError_('PERMANENT_DELETE_DISABLED','ไม่อนุญาตให้ลบข้อมูลหน่วยงานถาวรผ่าน API');
  updateRecord_('Agencies','agency_id',id,{status:'INACTIVE',updated_by:user.user_id,updated_at:nowIso_()});writeAudit_(user,'agencies.deactivate','agencies','Agency',id,'ปิดใช้งานหน่วยงาน',a,{status:'INACTIVE'},context);return {deactivated:true};
}

function ensureAgencyDefaultRole_(agencyId,actorId) {
  var roleId='role_agency_admin_'+slug_(agencyId);
  if(!getRecordById_('Roles','role_id',roleId))appendRecord_('Roles',{role_id:roleId,agency_id:agencyId,role_code:'AGENCY_ADMIN',role_name:'ผู้ดูแลหน่วยงาน',role_description:'จัดการข้อมูลและผู้ใช้งานภายในหน่วยงาน',is_system_role:true,is_active:true,created_by:actorId,created_at:nowIso_(),updated_by:actorId,updated_at:nowIso_()});
  var existing=readTable_('RolePermissions').filter(function(r){return r.role_id===roleId;});
  if(!existing.some(function(r){return r.permission_code==='*';}))appendRecord_('RolePermissions',{role_permission_id:generateId_('rp'),role_id:roleId,permission_code:'*',agency_id:agencyId,created_by:actorId,created_at:nowIso_()});
}

/* ========================================================================== */
/* 09. USER, DEPARTMENT, ROLE AND PERMISSION MANAGEMENT                       */
/* ========================================================================== */
function listUsers_(user,data) {
  var rows=readTable_('Users').filter(function(r){return r.agency_id===user.agency_id||isTrue_(user.is_super_admin)&&(!data.agencyId||r.agency_id===data.agencyId);});
  if(!data.includeInactive)rows=rows.filter(function(r){return r.status==='ACTIVE'&&!r.deleted_at;});
  if(data.search){var q=String(data.search).toLowerCase();rows=rows.filter(function(r){return [r.username,r.display_name,r.first_name,r.last_name,r.email].join(' ').toLowerCase().indexOf(q)>=0;});}
  return paginate_(rows,data).map(publicUser_);
}
function getUser_(user,data) {var u=getRecordById_('Users', 'user_id',String(data.userId||''));if(!u||u.deleted_at)throw apiError_('USER_NOT_FOUND','ไม่พบบัญชีผู้ใช้');assertSameAgencyOrSuper_(user,u.agency_id);return publicUser_(u);}
function createUser_(actor,data,context) {
  var agencyId=isTrue_(actor.is_super_admin)?String(data.agencyId||''):actor.agency_id;
  if(!agencyId||agencyId==='*')throw apiError_('AGENCY_REQUIRED','ต้องระบุหน่วยงานของผู้ใช้');
  if(isTrue_(actor.is_super_admin)&&!getAgencyRecord_(agencyId))throw apiError_('AGENCY_NOT_FOUND','ไม่พบหน่วยงาน');
  var username=String(data.username||'').trim().toLowerCase(),password=String(data.password||''),display=String(data.displayName||'').trim();
  if(!/^[a-z0-9._-]{3,64}$/.test(username))throw apiError_('INVALID_USERNAME','ชื่อผู้ใช้ต้องมี 3–64 ตัว และใช้ a-z, 0-9, จุด ขีด หรือขีดล่าง');
  if(!display)throw apiError_('DISPLAY_NAME_REQUIRED','กรุณาระบุชื่อที่แสดง');
  validateNewPassword_(password);
  if(readTable_('Users').some(function(r){return r.agency_id===agencyId&&String(r.username).toLowerCase()===username&&!r.deleted_at;}))throw apiError_('USERNAME_EXISTS','ชื่อผู้ใช้นี้มีอยู่ในหน่วยงานแล้ว');
  var roleId=String(data.roleId||'role_staff');assertRoleBelongsToAgency_(roleId,agencyId);
  var h=hashPassword_(password,secureRandomToken_(context,16),context),now=nowIso_();
  var u={user_id:generateId_('usr'),agency_id:agencyId,username:username,password_hash:h.hash,password_salt:h.salt,password_algorithm:'PBKDF2-HMAC-SHA256',password_iterations:APP.PBKDF2_ITERATIONS,display_name:display,first_name:String(data.firstName||''),last_name:String(data.lastName||''),email:String(data.email||''),phone:String(data.phone||''),position:String(data.position||''),department_id:String(data.departmentId||''),role_id:roleId,is_super_admin:false,status:'ACTIVE',must_change_password:isTrue_(data.mustChangePassword),failed_login_count:0,locked_until:'',last_login_at:'',last_password_change_at:'',avatar_url:String(data.avatarUrl||''),notification_preferences_json:JSON.stringify(data.notificationPreferences||{}),created_by:actor.user_id,created_at:now,updated_by:actor.user_id,updated_at:now,deleted_at:''};
  appendRecord_('Users',u);writeAudit_(actor,'users.create','users','User',u.user_id,'เพิ่มผู้ใช้งาน '+username,null,publicUser_(u),context);return publicUser_(u);
}
function updateUser_(actor,data,context) {
  var id=String(data.userId||''),old=getRecordById_('Users','user_id',id);if(!old||old.deleted_at)throw apiError_('USER_NOT_FOUND','ไม่พบบัญชีผู้ใช้');assertSameAgencyOrSuper_(actor,old.agency_id);
  if(isTrue_(old.is_super_admin)&&!isTrue_(actor.is_super_admin))throw apiError_('FORBIDDEN','ไม่สามารถแก้ไขบัญชี Super Admin');
  var p={updated_by:actor.user_id,updated_at:nowIso_()};
  var map={display_name:'displayName',first_name:'firstName',last_name:'lastName',email:'email',phone:'phone',position:'position',department_id:'departmentId',avatar_url:'avatarUrl',status:'status'};
  Object.keys(map).forEach(function(k){if(data[map[k]]!==undefined)p[k]=String(data[map[k]]);});
  if(data.roleId!==undefined){assertRoleBelongsToAgency_(String(data.roleId),old.agency_id);p.role_id=String(data.roleId);}
  if(data.notificationPreferences!==undefined)p.notification_preferences_json=JSON.stringify(data.notificationPreferences);
  if(data.password!==undefined&&String(data.password)){validateNewPassword_(String(data.password));var h=hashPassword_(String(data.password),secureRandomToken_(context,16),context);p.password_hash=h.hash;p.password_salt=h.salt;p.password_iterations=APP.PBKDF2_ITERATIONS;p.must_change_password=true;p.last_password_change_at=nowIso_();revokeUserSessions_(id);}
  updateRecord_('Users','user_id',id,p);writeAudit_(actor,'users.update','users','User',id,'แก้ไขผู้ใช้งาน',publicUser_(old),p,context);return publicUser_(getRecordById_('Users','user_id',id));
}
function deactivateUser_(actor,data,context) {
  var id=String(data.userId||''),u=getRecordById_('Users','user_id',id);if(!u)throw apiError_('USER_NOT_FOUND','ไม่พบบัญชีผู้ใช้');assertSameAgencyOrSuper_(actor,u.agency_id);
  if(u.user_id===actor.user_id)throw apiError_('SELF_DEACTIVATE_BLOCKED','ไม่สามารถปิดบัญชีที่กำลังใช้งานอยู่');
  if(isTrue_(u.is_super_admin))throw apiError_('SUPER_ADMIN_PROTECTED','ไม่สามารถปิดบัญชี Super Admin ผ่านเมนูนี้');
  updateRecord_('Users','user_id',id,{status:'INACTIVE',deleted_at:nowIso_(),updated_by:actor.user_id,updated_at:nowIso_()});revokeUserSessions_(id);writeAudit_(actor,'users.deactivate','users','User',id,'ปิดใช้งานผู้ใช้',publicUser_(u),{status:'INACTIVE'},context);return {deactivated:true};
}
function adminResetUserPassword_(actor,data,context) {
  var id=String(data.userId||''),u=getRecordById_('Users','user_id',id);if(!u)throw apiError_('USER_NOT_FOUND','ไม่พบบัญชีผู้ใช้');assertSameAgencyOrSuper_(actor,u.agency_id);if(isTrue_(u.is_super_admin))throw apiError_('SUPER_ADMIN_PROTECTED','ไม่สามารถรีเซ็ตรหัสผ่าน Super Admin ผ่านเมนูนี้');
  var temp=secureRandomToken_(context,18),h=hashPassword_(temp,secureRandomToken_(context,16),context);
  updateRecord_('Users','user_id',id,{password_hash:h.hash,password_salt:h.salt,password_iterations:APP.PBKDF2_ITERATIONS,must_change_password:true,failed_login_count:0,locked_until:'',last_password_change_at:nowIso_(),updated_by:actor.user_id,updated_at:nowIso_()});revokeUserSessions_(id);
  writeAudit_(actor,'users.resetPassword','users','User',id,'รีเซ็ตรหัสผ่านผู้ใช้',null,{mustChangePassword:true},context);
  return {temporaryPassword:temp,mustChangePassword:true,warning:'แสดงรหัสผ่านชั่วคราวครั้งเดียว กรุณาส่งมอบผู้ใช้อย่างปลอดภัย'};
}

function listDepartments_(user,data) {
  var targetAgency=String(data.agencyId||user.agency_id);var rows=readTable_('Departments').filter(function(r){return (isTrue_(user.is_super_admin)&&(!data.agencyId||targetAgency==='*'||r.agency_id===targetAgency)||r.agency_id===user.agency_id)&&(!data.includeInactive||r.status==='ACTIVE'||isTrue_(user.is_super_admin));});
  if(!isTrue_(data.includeInactive))rows=rows.filter(function(r){return r.status==='ACTIVE'&&!r.deleted_at;});
  return paginate_(rows,data);
}
function createDepartment_(actor,data,context) {
  var agencyId=isTrue_(actor.is_super_admin)?String(data.agencyId||actor.agency_id):actor.agency_id;
  if(!getAgencyRecord_(agencyId))throw apiError_('AGENCY_NOT_FOUND','ไม่พบหน่วยงาน');
  var name=String(data.departmentName||'').trim(),code=String(data.departmentCode||'').trim().toUpperCase();if(!name)throw apiError_('DEPARTMENT_NAME_REQUIRED','กรุณาระบุชื่อฝ่ายหรือกลุ่มงาน');
  if(readTable_('Departments').some(function(r){return r.agency_id===agencyId&&r.department_code===code&&!r.deleted_at;}))throw apiError_('DEPARTMENT_CODE_EXISTS','รหัสฝ่ายนี้มีอยู่แล้ว');
  var now=nowIso_(),d={department_id:generateId_('dep'),agency_id:agencyId,department_code:code,department_name:name,parent_department_id:String(data.parentDepartmentId||''),head_user_id:String(data.headUserId||''),phone:String(data.phone||''),email:String(data.email||''),sort_order:Number(data.sortOrder)||0,status:'ACTIVE',created_by:actor.user_id,created_at:now,updated_by:actor.user_id,updated_at:now,deleted_at:''};
  appendRecord_('Departments',d);writeAudit_(actor,'departments.create','departments','Department',d.department_id,'เพิ่มฝ่าย/กลุ่มงาน '+name,null,d,context);return d;
}
function updateDepartment_(actor,data,context) {
  var id=String(data.departmentId||''),old=getRecordById_('Departments','department_id',id);if(!old)throw apiError_('DEPARTMENT_NOT_FOUND','ไม่พบฝ่ายหรือกลุ่มงาน');assertSameAgencyOrSuper_(actor,old.agency_id);
  var p={updated_by:actor.user_id,updated_at:nowIso_()},map={departmentCode:'department_code',departmentName:'department_name',parentDepartmentId:'parent_department_id',headUserId:'head_user_id',phone:'phone',email:'email',sortOrder:'sort_order',status:'status'};
  Object.keys(map).forEach(function(k){if(data[k]!==undefined)p[map[k]]=k==='sortOrder'?Number(data[k]):String(data[k]);});updateRecord_('Departments','department_id',id,p);writeAudit_(actor,'departments.update','departments','Department',id,'แก้ไขฝ่าย/กลุ่มงาน',old,p,context);return getRecordById_('Departments','department_id',id);
}
function deactivateDepartment_(actor,data,context) {
  var id=String(data.departmentId||''),d=getRecordById_('Departments','department_id',id);if(!d)throw apiError_('DEPARTMENT_NOT_FOUND','ไม่พบฝ่าย');assertSameAgencyOrSuper_(actor,d.agency_id);updateRecord_('Departments','department_id',id,{status:'INACTIVE',deleted_at:nowIso_(),updated_by:actor.user_id,updated_at:nowIso_()});writeAudit_(actor,'departments.deactivate','departments','Department',id,'ปิดใช้งานฝ่าย',d,null,context);return {deactivated:true};
}

function listRoles_(user,data) {
  var targetAgency=String(data.agencyId||user.agency_id);
  if(!isTrue_(user.is_super_admin)&&targetAgency!==user.agency_id)throw apiError_('AGENCY_FORBIDDEN','ไม่มีสิทธิ์ดูบทบาทของหน่วยงานนี้');
  var rows=readTable_('Roles').filter(function(r){return r.agency_id==='*'||r.agency_id===targetAgency||r.agency_id===user.agency_id;});
  if(!isTrue_(data.includeInactive))rows=rows.filter(function(r){return isTrue_(r.is_active);});
  return paginate_(rows,data).map(function(r){r.permissionCodes=getRolePermissionCodes_(r.role_id);return r;});
}
function createRole_(actor,data,context) {
  var agencyId=isTrue_(actor.is_super_admin)?String(data.agencyId||actor.agency_id):actor.agency_id,name=String(data.roleName||'').trim(),code=String(data.roleCode||'').trim().toUpperCase();
  if(!getAgencyRecord_(agencyId))throw apiError_('AGENCY_NOT_FOUND','ไม่พบหน่วยงาน');
  if(!name||!code)throw apiError_('ROLE_FIELDS_REQUIRED','กรุณาระบุรหัสและชื่อบทบาท');
  if(readTable_('Roles').some(function(r){return (r.agency_id===agencyId||r.agency_id==='*')&&r.role_code===code;}))throw apiError_('ROLE_CODE_EXISTS','รหัสบทบาทนี้มีอยู่แล้ว');
  var r={role_id:generateId_('rol'),agency_id:agencyId,role_code:code,role_name:name,role_description:String(data.description||''),is_system_role:false,is_active:true,created_by:actor.user_id,created_at:nowIso_(),updated_by:actor.user_id,updated_at:nowIso_()};appendRecord_('Roles',r);
  if(Array.isArray(data.permissionCodes))setRolePermissionsInternal_(r.role_id,agencyId,data.permissionCodes,actor.user_id);
  writeAudit_(actor,'roles.create','roles','Role',r.role_id,'สร้างบทบาท '+name,null,r,context);return r;
}
function updateRole_(actor,data,context) {
  var id=String(data.roleId||''),r=getRecordById_('Roles','role_id',id);if(!r)throw apiError_('ROLE_NOT_FOUND','ไม่พบบทบาท');assertSameAgencyOrSuper_(actor,r.agency_id);
  if(isTrue_(r.is_system_role)&&!isTrue_(actor.is_super_admin))throw apiError_('SYSTEM_ROLE_PROTECTED','ไม่สามารถแก้ไขบทบาทระบบ');
  var p={updated_by:actor.user_id,updated_at:nowIso_()};if(data.roleName!==undefined)p.role_name=String(data.roleName);if(data.description!==undefined)p.role_description=String(data.description);if(data.isActive!==undefined)p.is_active=!!data.isActive;
  updateRecord_('Roles','role_id',id,p);writeAudit_(actor,'roles.update','roles','Role',id,'แก้ไขบทบาท',r,p,context);return getRecordById_('Roles','role_id',id);
}
function setRolePermissions_(actor,data,context) {
  var id=String(data.roleId||''),r=getRecordById_('Roles','role_id',id);if(!r)throw apiError_('ROLE_NOT_FOUND','ไม่พบบทบาท');assertSameAgencyOrSuper_(actor,r.agency_id);
  if(!Array.isArray(data.permissionCodes))throw apiError_('PERMISSIONS_REQUIRED','ต้องส่งรายการ permissionCodes เป็น Array');
  setRolePermissionsInternal_(id,r.agency_id,data.permissionCodes,actor.user_id);writeAudit_(actor,'roles.setPermissions','roles','Role',id,'กำหนดสิทธิ์บทบาท',null,data.permissionCodes,context);return {updated:true,permissionCodes:getRolePermissionCodes_(id)};
}
function setRolePermissionsInternal_(roleId,agencyId,codes,actorId) {
  var valid=DEFAULT_PERMISSIONS.map(function(p){return p[0];});
  if(codes.some(function(c){return valid.indexOf(String(c))<0;}))throw apiError_('UNKNOWN_PERMISSION','พบรหัสสิทธิ์ที่ไม่มีในระบบ');
  readTable_('RolePermissions').filter(function(r){return r.role_id===roleId;}).forEach(function(r){deleteRecord_('RolePermissions','role_permission_id',r.role_permission_id);});
  codes.forEach(function(code){appendRecord_('RolePermissions',{role_permission_id:generateId_('rp'),role_id:roleId,permission_code:String(code),agency_id:agencyId,created_by:actorId,created_at:nowIso_()});});
}
function listPermissions_(){return readTable_('Permissions');}
function getRolePermissionCodes_(roleId){return readTable_('RolePermissions').filter(function(r){return r.role_id===roleId;}).map(function(r){return r.permission_code;});}
function getUserPermissionCodes_(user){if(isTrue_(user.is_super_admin))return ['*'];var role=getRecordById_('Roles','role_id',user.role_id);if(!role||!isTrue_(role.is_active))return [];return getRolePermissionCodes_(user.role_id);}
function assertRoleBelongsToAgency_(roleId,agencyId){var r=getRecordById_('Roles','role_id',roleId);if(!r||!isTrue_(r.is_active)||r.role_code==='SUPER_ADMIN')throw apiError_('ROLE_INVALID','บทบาทผู้ใช้ไม่ถูกต้อง');if(r.agency_id!=='*'&&r.agency_id!==agencyId)throw apiError_('ROLE_AGENCY_MISMATCH','บทบาทนี้ไม่ได้อยู่ในหน่วยงานที่กำหนด');}

/* ========================================================================== */
/* 10. INCOMING AND OUTGOING REGISTRIES                                       */
/* ========================================================================== */
var BOOK_FIELD_MAP = {
  IncomingBooks:{date:'receivedDate',number:'documentNumber',docDate:'documentDate',subject:'subject',agency:'senderAgency',user:'responsibleUserId',department:'departmentId'},
  OutgoingBooks:{date:'sentDate',number:'documentNumber',docDate:'documentDate',subject:'subject',agency:'recipientAgency',user:'responsibleUserId',department:'departmentId'}
};

function listBooks_(sheetName,user,data) {
  var agencyId=String(data.agencyId||user.agency_id),rows=readTable_(sheetName).filter(function(r){return r.agency_id===agencyId&&!r.deleted_at;});
  if(!isTrue_(user.is_super_admin)&&agencyId!==user.agency_id)throw apiError_('AGENCY_FORBIDDEN','ไม่มีสิทธิ์เข้าถึงทะเบียนของหน่วยงานนี้');
  if(data.status)rows=rows.filter(function(r){return r.status===String(data.status);});
  if(data.year)rows=rows.filter(function(r){return String(r.registration_year)===String(data.year);});
  if(data.priorityLevel)rows=rows.filter(function(r){return r.priority_level===String(data.priorityLevel);});
  if(data.departmentId)rows=rows.filter(function(r){return r.department_id===String(data.departmentId);});
  if(data.responsibleUserId)rows=rows.filter(function(r){return r.responsible_user_id===String(data.responsibleUserId);});
  if(data.dateFrom)rows=rows.filter(function(r){return String(r.received_date||r.sent_date)>=String(data.dateFrom);});
  if(data.dateTo)rows=rows.filter(function(r){return String(r.received_date||r.sent_date)<=String(data.dateTo);});
  if(data.search){var q=String(data.search).toLowerCase();rows=rows.filter(function(r){return [r.registration_no,r.document_number,r.subject,r.sender_agency,r.recipient_agency,r.sender_name,r.recipient_name,r.remarks].join(' ').toLowerCase().indexOf(q)>=0;});}
  rows.sort(function(a,b){return String(b.created_at).localeCompare(String(a.created_at));});
  return paginate_(rows,data).map(publicBook_);
}

function getBook_(sheetName,user,data) {
  var id=String(data.bookId||''),r=getRecordById_(sheetName,'book_id',id);if(!r||r.deleted_at)throw apiError_('BOOK_NOT_FOUND','ไม่พบรายการหนังสือ');assertSameAgencyOrSuper_(user,r.agency_id);
  var result=publicBook_(r);result.attachments=listAttachmentsInternal_(r.agency_id,r.book_id);return result;
}

function createBook_(sheetName,actor,data,context) {
  var agencyId=isTrue_(actor.is_super_admin)?String(data.agencyId||actor.agency_id):actor.agency_id;
  var agency=getAgencyRecord_(agencyId);if(!agency||agency.status!=='ACTIVE')throw apiError_('AGENCY_NOT_FOUND','ไม่พบหน่วยงานหรือหน่วยงานปิดใช้งาน');
  var subject=String(data.subject||'').trim();if(!subject)throw apiError_('SUBJECT_REQUIRED','กรุณาระบุเรื่องหนังสือ');
  validateBookReferences_(agencyId,data);
  var dateValue=normalizeDate_(sheetName==='IncomingBooks'?data.receivedDate:data.sentDate)||today_();
  var lock=LockService.getScriptLock();lock.waitLock(25000);
  try {
    var fiscalYear=getFiscalYearForAgency_(dateValue,agency),sequence=nextSequence_(agency,sheetName,fiscalYear,actor.user_id);
    var now=nowIso_(),id=generateId_(sheetName==='IncomingBooks'?'inc':'out');
    var r={book_id:id,agency_id:agencyId,registration_no:sequence.registrationNo,registration_year:fiscalYear,sequence_no:sequence.number,
      received_date:sheetName==='IncomingBooks'?dateValue:'',sent_date:sheetName==='OutgoingBooks'?dateValue:'',document_number:String(data.documentNumber||''),document_date:normalizeDate_(data.documentDate),
      sender_name:String(data.senderName||''),sender_agency:String(data.senderAgency||''),sender_address:String(data.senderAddress||''),sender_contact:String(data.senderContact||''),
      recipient_name:String(data.recipientName||''),recipient_position:String(data.recipientPosition||''),recipient_agency:String(data.recipientAgency||''),recipient_address:String(data.recipientAddress||''),recipient_contact:String(data.recipientContact||''),
      subject:subject,summary:String(data.summary||''),document_type_id:String(data.documentTypeId||''),category_id:String(data.categoryId||''),priority_level:String(data.priorityLevel||'ปกติ'),confidentiality_level:String(data.confidentialityLevel||'ปกติ'),
      signatory_user_id:String(data.signatoryUserId||''),signatory_name:String(data.signatoryName||''),signatory_position:String(data.signatoryPosition||''),department_id:String(data.departmentId||''),responsible_user_id:String(data.responsibleUserId||''),due_date:normalizeDate_(data.dueDate),
      received_channel:String(data.receivedChannel||''),sent_channel:String(data.sentChannel||''),tracking_number:String(data.trackingNumber||''),status:String(data.status||(sheetName==='IncomingBooks'?'RECEIVED':'REGISTERED')),parent_book_id:String(data.parentBookId||''),related_incoming_book_id:String(data.relatedIncomingBookId||''),external_reference:String(data.externalReference||''),remarks:String(data.remarks||''),primary_attachment_id:'',attachment_count:0,tags_json:JSON.stringify(Array.isArray(data.tags)?data.tags:[]),created_by:actor.user_id,created_at:now,updated_by:actor.user_id,updated_at:now,deleted_at:''};
    appendRecord_(sheetName,r);
    if(r.responsible_user_id)createNotification_(agencyId,r.responsible_user_id,'BOOK_ASSIGNED','มีหนังสือมอบหมาย','คุณได้รับมอบหมายหนังสือ '+r.registration_no,sheetName,r.book_id,'');
    appendWorkflowEvent_(actor,agencyId,sheetName==='IncomingBooks'?'INCOMING':'OUTGOING',id,'CREATE','',r.status,'สร้างรายการทะเบียน '+r.registration_no,context);
    writeAudit_(actor,sheetName==='IncomingBooks'?'books.incoming.create':'books.outgoing.create','registry',sheetName,r.book_id,'เพิ่มทะเบียน '+r.registration_no,null,publicBook_(r),context);
    return publicBook_(r);
  } finally {lock.releaseLock();}
}

function updateBook_(sheetName,actor,data,context) {
  var id=String(data.bookId||''),old=getRecordById_(sheetName,'book_id',id);if(!old||old.deleted_at)throw apiError_('BOOK_NOT_FOUND','ไม่พบรายการหนังสือ');assertSameAgencyOrSuper_(actor,old.agency_id);
  validateBookReferences_(old.agency_id,data);
  var fields=['document_number','document_date','sender_name','sender_agency','sender_address','sender_contact','recipient_name','recipient_position','recipient_agency','recipient_address','recipient_contact','subject','summary','document_type_id','category_id','priority_level','confidentiality_level','signatory_user_id','signatory_name','signatory_position','department_id','responsible_user_id','due_date','received_channel','sent_channel','tracking_number','status','parent_book_id','related_incoming_book_id','external_reference','remarks'];
  var camel=['documentNumber','documentDate','senderName','senderAgency','senderAddress','senderContact','recipientName','recipientPosition','recipientAgency','recipientAddress','recipientContact','subject','summary','documentTypeId','categoryId','priorityLevel','confidentialityLevel','signatoryUserId','signatoryName','signatoryPosition','departmentId','responsibleUserId','dueDate','receivedChannel','sentChannel','trackingNumber','status','parentBookId','relatedIncomingBookId','externalReference','remarks'];
  var patch={updated_by:actor.user_id,updated_at:nowIso_()};fields.forEach(function(k,i){if(data[camel[i]]!==undefined)patch[k]=['document_date','due_date'].indexOf(k)>=0?normalizeDate_(data[camel[i]]):String(data[camel[i]]);});
  if(data.tags!==undefined)patch.tags_json=JSON.stringify(Array.isArray(data.tags)?data.tags:[]);
  if(data.status!==undefined&&String(data.status)!==old.status)appendWorkflowEvent_(actor,old.agency_id,sheetName==='IncomingBooks'?'INCOMING':'OUTGOING',id,'STATUS_CHANGE',old.status,String(data.status),'เปลี่ยนสถานะหนังสือ',context);
  updateRecord_(sheetName,'book_id',id,patch);writeAudit_(actor,'books.update','registry',sheetName,id,'แก้ไขทะเบียนหนังสือ',publicBook_(old),patch,context);return publicBook_(getRecordById_(sheetName,'book_id',id));
}

function deleteBook_(sheetName,actor,data,context) {
  var id=String(data.bookId||''),old=getRecordById_(sheetName,'book_id',id);if(!old||old.deleted_at)throw apiError_('BOOK_NOT_FOUND','ไม่พบรายการหนังสือ');assertSameAgencyOrSuper_(actor,old.agency_id);
  updateRecord_(sheetName,'book_id',id,{status:'CANCELLED',deleted_at:nowIso_(),updated_by:actor.user_id,updated_at:nowIso_()});appendWorkflowEvent_(actor,old.agency_id,sheetName==='IncomingBooks'?'INCOMING':'OUTGOING',id,'CANCEL',old.status,'CANCELLED','ยกเลิกรายการทะเบียน',context);writeAudit_(actor,'books.delete','registry',sheetName,id,'ยกเลิกรายการทะเบียน',publicBook_(old),{status:'CANCELLED'},context);return {cancelled:true};
}

function validateBookReferences_(agencyId,data) {
  var docId=String(data.documentTypeId||''),catId=String(data.categoryId||''),deptId=String(data.departmentId||''),userIds=[String(data.responsibleUserId||''),String(data.signatoryUserId||'')].filter(Boolean);
  if(docId){var doc=getRecordById_('DocumentTypes','document_type_id',docId);if(!doc||!isTrue_(doc.is_active)||(doc.agency_id!=='*'&&doc.agency_id!==agencyId))throw apiError_('DOCUMENT_TYPE_INVALID','ประเภทหนังสือไม่ถูกต้อง');}
  if(catId){var cat=getRecordById_('BookCategories','category_id',catId);if(!cat||!isTrue_(cat.is_active)||(cat.agency_id!=='*'&&cat.agency_id!==agencyId))throw apiError_('CATEGORY_INVALID','หมวดหมู่หนังสือไม่ถูกต้อง');}
  if(deptId){var dept=getRecordById_('Departments','department_id',deptId);if(!dept||dept.agency_id!==agencyId||dept.status!=='ACTIVE')throw apiError_('DEPARTMENT_INVALID','ฝ่ายหรือกลุ่มงานไม่ถูกต้อง');}
  userIds.forEach(function(id){var u=getRecordById_('Users','user_id',id);if(!u||u.agency_id!==agencyId||u.status!=='ACTIVE')throw apiError_('BOOK_USER_INVALID','ผู้รับผิดชอบหรือผู้ลงนามไม่ถูกต้อง');});
  var related=String(data.relatedIncomingBookId||data.parentBookId||'');if(related){var r=getRecordById_('IncomingBooks','book_id',related);if(!r||r.agency_id!==agencyId||r.deleted_at)throw apiError_('RELATED_BOOK_INVALID','หนังสืออ้างอิงไม่ถูกต้อง');}
}

function nextSequence_(agency,sheetName,fiscalYear,userId) {
  var bookType=sheetName==='IncomingBooks'?'INCOMING':'OUTGOING',agencyId=agency.agency_id,counterId=agencyId+'|'+bookType+'|'+fiscalYear;
  var counter=getRecordById_('SequenceCounters','counter_id',counterId),number=counter?Number(counter.last_number)+1:1;
  var prefix=bookType==='INCOMING'?String(agency.incoming_prefix||'รับ'):String(agency.outgoing_prefix||'ส่ง');
  var registrationNo=prefix+'/'+String(number).padStart(4,'0')+'/'+fiscalYear;
  if(counter)updateRecord_('SequenceCounters','counter_id',counterId,{last_number:number,updated_at:nowIso_(),updated_by:userId});
  else appendRecord_('SequenceCounters',{counter_id:counterId,agency_id:agencyId,book_type:bookType,fiscal_year:fiscalYear,prefix:prefix,last_number:number,updated_at:nowIso_(),updated_by:userId});
  return {number:number,registrationNo:registrationNo};
}

/* ========================================================================== */
/* 11. ASSIGNMENTS AND WORKFLOW                                               */
/* ========================================================================== */
function listAssignments_(user,data) {
  var targetAgency=String(data.agencyId||user.agency_id);
  if(!isTrue_(user.is_super_admin)&&targetAgency!==user.agency_id)throw apiError_('AGENCY_FORBIDDEN','ไม่มีสิทธิ์ดูงานของหน่วยงานนี้');
  var rows=readTable_('Assignments').filter(function(r){return (targetAgency==='*'&&isTrue_(user.is_super_admin)||r.agency_id===targetAgency)&&(!data.status||r.status===data.status);});
  if(!isTrue_(user.is_super_admin))rows=rows.filter(function(r){return !data.mineOnly||r.assigned_to_user_id===user.user_id||r.assigned_from_user_id===user.user_id;});
  if(data.bookId)rows=rows.filter(function(r){return r.book_id===String(data.bookId);});
  return paginate_(rows.sort(function(a,b){return String(b.created_at).localeCompare(String(a.created_at));}),data);
}
function createAssignment_(actor,data,context) {
  var agencyId=isTrue_(actor.is_super_admin)?String(data.agencyId||actor.agency_id):actor.agency_id,bookType=String(data.bookType||'INCOMING').toUpperCase(),table=bookType==='INCOMING'?'IncomingBooks':bookType==='OUTGOING'?'OutgoingBooks':'';
  if(!table)throw apiError_('BOOK_TYPE_INVALID','ประเภทหนังสือไม่ถูกต้อง');
  var book=getRecordById_(table,'book_id',String(data.bookId||''));if(!book||book.agency_id!==agencyId||book.deleted_at)throw apiError_('BOOK_NOT_FOUND','ไม่พบหนังสือในหน่วยงานนี้');
  var toUser=String(data.assignedToUserId||'');if(toUser){var target=getRecordById_('Users','user_id',toUser);if(!target||target.agency_id!==agencyId||String(target.status).toUpperCase()!=='ACTIVE')throw apiError_('ASSIGNEE_INVALID','ผู้รับมอบหมายไม่ถูกต้อง');}
  var toDepartment=String(data.assignedToDepartmentId||'');if(toDepartment){var dept=getRecordById_('Departments','department_id',toDepartment);if(!dept||dept.agency_id!==agencyId||dept.status!=='ACTIVE')throw apiError_('DEPARTMENT_INVALID','ฝ่ายผู้รับมอบหมายไม่ถูกต้อง');}
  var now=nowIso_(),a={assignment_id:generateId_('asn'),agency_id:agencyId,book_type:bookType,book_id:book.book_id,assigned_from_user_id:actor.user_id,assigned_to_user_id:toUser,assigned_to_department_id:String(data.assignedToDepartmentId||''),assignment_title:String(data.title||book.subject),instructions:String(data.instructions||''),priority_level:String(data.priorityLevel||book.priority_level||'ปกติ'),assigned_at:now,due_at:normalizeDate_(data.dueAt),status:'PENDING',completed_at:'',completion_note:'',created_by:actor.user_id,created_at:now,updated_by:actor.user_id,updated_at:now};
  appendRecord_('Assignments',a);if(toUser)createNotification_(agencyId,toUser,'ASSIGNMENT_NEW','มีงานมอบหมาย',a.assignment_title,'Assignment',a.assignment_id,'');appendWorkflowEvent_(actor,agencyId,bookType,book.book_id,'ASSIGN',book.status,book.status,'มอบหมายงาน '+a.assignment_title,context);writeAudit_(actor,'assignments.create','workflow','Assignment',a.assignment_id,'มอบหมายงาน',null,a,context);return a;
}
function updateAssignment_(actor,data,context) {
  var id=String(data.assignmentId||''),a=getRecordById_('Assignments','assignment_id',id);if(!a)throw apiError_('ASSIGNMENT_NOT_FOUND','ไม่พบงานที่มอบหมาย');assertSameAgencyOrSuper_(actor,a.agency_id);
  var isInvolved=a.assigned_to_user_id===actor.user_id||a.assigned_from_user_id===actor.user_id||isTrue_(actor.is_super_admin);if(!isInvolved&&!hasPermission_(actor,'assignments.manage'))throw apiError_('FORBIDDEN','ไม่มีสิทธิ์แก้ไขงานนี้');
  var status=String(data.status||a.status).toUpperCase();if(['PENDING','IN_PROGRESS','COMPLETED','CANCELLED'].indexOf(status)<0)throw apiError_('ASSIGNMENT_STATUS_INVALID','สถานะงานไม่ถูกต้อง');var patch={updated_by:actor.user_id,updated_at:nowIso_(),status:status};
  if(data.completionNote!==undefined)patch.completion_note=String(data.completionNote);if(data.instructions!==undefined)patch.instructions=String(data.instructions);if(data.dueAt!==undefined)patch.due_at=normalizeDate_(data.dueAt);
  if(status==='COMPLETED')patch.completed_at=nowIso_();updateRecord_('Assignments','assignment_id',id,patch);
  if(status==='COMPLETED')createNotification_(a.agency_id,a.assigned_from_user_id,'ASSIGNMENT_COMPLETED','ดำเนินงานเสร็จแล้ว',a.assignment_title,'Assignment',id,'');writeAudit_(actor,'assignments.update','workflow','Assignment',id,'ปรับปรุงงานมอบหมาย',a,patch,context);return getRecordById_('Assignments','assignment_id',id);
}
function listWorkflow_(user,data) {
  var targetAgency=String(data.agencyId||user.agency_id);if(!isTrue_(user.is_super_admin)&&targetAgency!==user.agency_id)throw apiError_('AGENCY_FORBIDDEN','ไม่มีสิทธิ์ดูประวัติหน่วยงานนี้');
  var rows=readTable_('WorkflowLogs').filter(function(r){return (targetAgency==='*'&&isTrue_(user.is_super_admin)||r.agency_id===targetAgency)&&(!data.bookId||r.book_id===String(data.bookId))&&(!data.bookType||r.book_type===String(data.bookType));});
  return paginate_(rows.sort(function(a,b){return String(b.action_at).localeCompare(String(a.action_at));}),data);
}
function addWorkflow_(actor,data,context) {
  var agencyId=isTrue_(actor.is_super_admin)?String(data.agencyId||actor.agency_id):actor.agency_id,bookType=String(data.bookType||'INCOMING').toUpperCase(),table=bookType==='INCOMING'?'IncomingBooks':bookType==='OUTGOING'?'OutgoingBooks':'';
  if(!table)throw apiError_('BOOK_TYPE_INVALID','ประเภทหนังสือไม่ถูกต้อง');var book=getRecordById_(table,'book_id',String(data.bookId||''));if(!book||book.agency_id!==agencyId)throw apiError_('BOOK_NOT_FOUND','ไม่พบหนังสือ');
  var event=String(data.actionType||'NOTE').toUpperCase(),toStatus=String(data.toStatus||book.status),note=String(data.note||'');
  if(data.toStatus!==undefined)updateRecord_(table,'book_id',book.book_id,{status:toStatus,updated_by:actor.user_id,updated_at:nowIso_()});
  var row=appendWorkflowEvent_(actor,agencyId,bookType,book.book_id,event,book.status,toStatus,note,context);
  if(data.notifyUserId)createNotification_(agencyId,String(data.notifyUserId),'WORKFLOW_UPDATE','มีการอัปเดตหนังสือ',note,bookType,book.book_id,'');
  writeAudit_(actor,'workflow.add','workflow','WorkflowLog',row.workflow_id,'บันทึกการดำเนินงาน',null,row,context);return row;
}
function appendWorkflowEvent_(actor,agencyId,bookType,bookId,event,fromStatus,toStatus,note,context) {
  var row={workflow_id:generateId_('wfl'),agency_id:agencyId,book_type:bookType,book_id:bookId,action_type:event,from_status:fromStatus,to_status:toStatus,from_user_id:actor.user_id,to_user_id:'',to_department_id:'',action_note:String(note||''),action_at:nowIso_(),attachment_id:'',metadata_json:'{}',created_by:actor.user_id,created_at:nowIso_()};appendRecord_('WorkflowLogs',row);return row;
}

/* ========================================================================== */
/* 12. PRIVATE DRIVE FILES, ATTACHMENTS AND DIRECT DOWNLOADS                  */
/* ========================================================================== */
var ALLOWED_FILE_TYPES = {
  'application/pdf':['pdf'],
  'application/msword':['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':['docx'],
  'application/vnd.ms-excel':['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['xlsx'],
  'text/plain':['txt'],
  'image/jpeg':['jpg','jpeg'],
  'image/png':['png'],
  'image/webp':['webp'],
  'image/gif':['gif']
};

function listAttachments_(user,data) {
  var targetAgency=String(data.agencyId||user.agency_id);if(!isTrue_(user.is_super_admin)&&targetAgency!==user.agency_id)throw apiError_('AGENCY_FORBIDDEN','ไม่มีสิทธิ์ดูไฟล์ของหน่วยงานนี้');
  var rows=readTable_('Attachments').filter(function(r){return (targetAgency==='*'&&isTrue_(user.is_super_admin)||r.agency_id===targetAgency)&&!r.deleted_at&&r.status==='ACTIVE';});
  if(data.bookId)rows=rows.filter(function(r){return r.book_id===String(data.bookId);});
  if(data.assignmentId)rows=rows.filter(function(r){return r.assignment_id===String(data.assignmentId);});
  if(data.category)rows=rows.filter(function(r){return r.category===String(data.category);});
  return paginate_(rows.sort(function(a,b){return String(b.uploaded_at).localeCompare(String(a.uploaded_at));}),data).map(publicAttachment_);
}
function listAttachmentsInternal_(agencyId,bookId) {return readTable_('Attachments').filter(function(r){return r.agency_id===agencyId&&r.book_id===bookId&&!r.deleted_at&&r.status==='ACTIVE';}).map(publicAttachment_);}

function uploadAttachment_(actor,data,context) {
  var agencyId=isTrue_(actor.is_super_admin)?String(data.agencyId||actor.agency_id):actor.agency_id;if(!getAgencyRecord_(agencyId))throw apiError_('AGENCY_NOT_FOUND','ไม่พบหน่วยงาน');
  var original=String(data.fileName||'').replace(/[\\/]/g,'_').trim(),mime=String(data.mimeType||'application/octet-stream').toLowerCase(),base64=String(data.fileBase64||'').replace(/^data:[^;]+;base64,/,'');
  if(!original||!base64)throw apiError_('FILE_DATA_REQUIRED','ต้องระบุชื่อไฟล์และข้อมูลไฟล์');
  var bytes=Utilities.base64Decode(base64);if(bytes.length>APP.MAX_UPLOAD_BYTES)throw apiError_('FILE_TOO_LARGE','ไฟล์มีขนาดเกิน '+formatBytes_(APP.MAX_UPLOAD_BYTES));
  var ext=(original.split('.').pop()||'').toLowerCase();if(!ALLOWED_FILE_TYPES[mime]||ALLOWED_FILE_TYPES[mime].indexOf(ext)<0)throw apiError_('FILE_TYPE_NOT_ALLOWED','ไม่อนุญาตชนิดไฟล์นี้');
  validateFileSignature_(bytes,mime);
  var bookType=String(data.bookType||''),bookId=String(data.bookId||''),bookTable=bookType==='INCOMING'?'IncomingBooks':bookType==='OUTGOING'?'OutgoingBooks':'';
  if(bookId){if(!bookTable)throw apiError_('BOOK_TYPE_INVALID','ต้องระบุประเภทหนังสือให้ถูกต้อง');var book=getRecordById_(bookTable,'book_id',bookId);if(!book||book.agency_id!==agencyId||book.deleted_at)throw apiError_('BOOK_NOT_FOUND','ไม่พบหนังสือที่ต้องการแนบไฟล์');}
  var folder=resolveAgencyFolder_(agencyId,data.folderType||(bookType==='INCOMING'?'Incoming':bookType==='OUTGOING'?'Outgoing':'Attachments'));
  var storedName=Utilities.getUuid()+'_'+sanitizeFileName_(original),blob=Utilities.newBlob(bytes,mime,storedName),file=folder.createFile(blob);file.setName(storedName);
  var row={attachment_id:generateId_('att'),agency_id:agencyId,book_type:bookType,book_id:bookId,assignment_id:String(data.assignmentId||''),drive_file_id:file.getId(),drive_folder_id:folder.getId(),original_file_name:original,stored_file_name:storedName,file_extension:ext,mime_type:mime,size_bytes:bytes.length,checksum_sha256:sha256HexBytes_(bytes),category:String(data.category||'GENERAL'),description:String(data.description||''),is_password_protected:false,status:'ACTIVE',uploaded_by:actor.user_id,uploaded_at:nowIso_(),updated_by:actor.user_id,updated_at:nowIso_(),deleted_at:''};
  appendRecord_('Attachments',row);
  if(bookId){var current=getRecordById_(bookTable,'book_id',bookId);updateRecord_(bookTable,'book_id',bookId,{primary_attachment_id:current.primary_attachment_id||row.attachment_id,attachment_count:(Number(current.attachment_count)||0)+1,updated_at:nowIso_()});}
  writeAudit_(actor,'attachments.upload','files','Attachment',row.attachment_id,'อัปโหลดไฟล์ '+original,null,publicAttachment_(row),context);return publicAttachment_(row);
}

function downloadAttachment_(actor,data,context) {
  var id=String(data.attachmentId||''),r=getRecordById_('Attachments','attachment_id',id);if(!r||r.status!=='ACTIVE'||r.deleted_at)throw apiError_('ATTACHMENT_NOT_FOUND','ไม่พบไฟล์แนบ');assertSameAgencyOrSuper_(actor,r.agency_id);
  var file=DriveApp.getFileById(r.drive_file_id);var blob=file.getBlob(),bytes=blob.getBytes();
  if(bytes.length>APP.MAX_DOWNLOAD_BYTES)throw apiError_('DOWNLOAD_TOO_LARGE','ไฟล์มีขนาดใหญ่เกินขีดจำกัดการดาวน์โหลดผ่าน API');
  var base64=Utilities.base64Encode(bytes),downloadId=generateId_('dl');
  appendRecord_('DownloadLogs',{download_id:downloadId,agency_id:r.agency_id,user_id:actor.user_id,attachment_id:r.attachment_id,drive_file_id_hash:sha256Hex_(r.drive_file_id),file_name:r.original_file_name,mime_type:r.mime_type,size_bytes:bytes.length,download_type:'ATTACHMENT',request_id:context.requestId,downloaded_at:nowIso_(),status:'SUCCESS'});
  writeAudit_(actor,'attachments.download','files','Attachment',r.attachment_id,'ดาวน์โหลดไฟล์ '+r.original_file_name,null,null,context);
  return {fileName:r.original_file_name,mimeType:r.mime_type,sizeBytes:bytes.length,fileBase64:base64,downloadId:downloadId};
}

function deleteAttachment_(actor,data,context) {
  var id=String(data.attachmentId||''),r=getRecordById_('Attachments','attachment_id',id);if(!r)throw apiError_('ATTACHMENT_NOT_FOUND','ไม่พบไฟล์แนบ');assertSameAgencyOrSuper_(actor,r.agency_id);
  updateRecord_('Attachments','attachment_id',id,{status:'DELETED',deleted_at:nowIso_(),updated_by:actor.user_id,updated_at:nowIso_()});
  writeAudit_(actor,'attachments.delete','files','Attachment',id,'ยกเลิกไฟล์แนบ '+r.original_file_name,r,{status:'DELETED'},context);return {deleted:true,driveFileRetained:true};
}

function validateFileSignature_(bytes,mime) {
  var b=bytes.slice(0,16).map(function(x){return (x+256)%256;}),ok=true;
  if(mime==='application/pdf')ok=b[0]===37&&b[1]===80&&b[2]===68&&b[3]===70&&b[4]===45;
  else if(mime==='image/png')ok=b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71;
  else if(mime==='image/jpeg')ok=b[0]===255&&b[1]===216&&b[2]===255;
  else if(mime==='image/gif')ok=b[0]===71&&b[1]===73&&b[2]===70;
  else if(mime==='image/webp')ok=b[0]===82&&b[1]===73&&b[2]===70&&b[8]===87&&b[9]===69&&b[10]===66&&b[11]===80;
  else if(mime.indexOf('wordprocessingml')>=0||mime.indexOf('spreadsheetml')>=0||mime==='application/msword'||mime==='application/vnd.ms-excel')ok=b[0]===80&&b[1]===75||b[0]===208&&b[1]===207;
  if(!ok)throw apiError_('FILE_SIGNATURE_INVALID','เนื้อหาไฟล์ไม่ตรงกับชนิดไฟล์ที่แจ้ง');
}

/* ========================================================================== */
/* 13. IMGBB IMAGE UPLOAD                                                     */
/* ========================================================================== */
function uploadImage_(actor,data,context) {
  var props=PropertiesService.getScriptProperties(),key=props.getProperty(PROP.IMGBB_API_KEY);if(!key)throw apiError_('IMGBB_NOT_CONFIGURED','ยังไม่ได้กำหนด IMGBB_API_KEY');
  var base64=String(data.imageBase64||'').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/,'');if(!base64)throw apiError_('IMAGE_REQUIRED','ไม่พบข้อมูลรูปภาพ');
  var bytes=Utilities.base64Decode(base64);if(bytes.length>APP.MAX_UPLOAD_BYTES)throw apiError_('IMAGE_TOO_LARGE','รูปภาพมีขนาดเกินกำหนด');
  var imageMime=String(data.mimeType||'image/jpeg').toLowerCase();if(['image/jpeg','image/png','image/webp','image/gif'].indexOf(imageMime)<0)throw apiError_('IMAGE_TYPE_NOT_ALLOWED','รองรับเฉพาะ JPEG, PNG, WebP และ GIF');validateFileSignature_(bytes,imageMime);
  var agencyId=isTrue_(actor.is_super_admin)?String(data.agencyId||actor.agency_id):actor.agency_id;if(!getAgencyRecord_(agencyId))throw apiError_('AGENCY_NOT_FOUND','ไม่พบหน่วยงาน');
  var response=UrlFetchApp.fetch('https://api.imgbb.com/1/upload?key='+encodeURIComponent(key),{method:'post',payload:{image:base64,name:sanitizeFileName_(String(data.fileName||'image'))},muteHttpExceptions:true});
  var status=response.getResponseCode(),body={};try{body=JSON.parse(response.getContentText());}catch(ignore){}
  if(status<200||status>=300||!body.success||!body.data)throw apiError_('IMGBB_UPLOAD_FAILED','ฝากรูปภาพกับ ImgBB ไม่สำเร็จ');
  var image=body.data,media={media_id:generateId_('med'),agency_id:agencyId,owner_type:String(data.ownerType||'GENERAL'),owner_id:String(data.ownerId||''),media_type:String(data.mediaType||'IMAGE'),provider:'IMGBB',image_url:String(image.url||''),display_url:String(image.display_url||image.url||''),thumbnail_url:String(image.thumb&&image.thumb.url||''),image_name:String(image.image&&image.image.filename||data.fileName||''),mime_type:String(image.image&&image.image.mime||data.mimeType||''),size_bytes:bytes.length,width:Number(image.width)||0,height:Number(image.height)||0,delete_hash:'',status:'ACTIVE',uploaded_by:actor.user_id,uploaded_at:nowIso_(),created_at:nowIso_()};
  appendRecord_('MediaAssets',media);writeAudit_(actor,'images.upload','media','MediaAsset',media.media_id,'อัปโหลดรูปภาพไปยัง ImgBB',null,{imageUrl:media.image_url},context);return {mediaId:media.media_id,imageUrl:media.image_url,displayUrl:media.display_url,thumbnailUrl:media.thumbnail_url,width:media.width,height:media.height};
}
function listImages_(user,data) {
  var targetAgency=String(data.agencyId||user.agency_id);if(!isTrue_(user.is_super_admin)&&targetAgency!==user.agency_id)throw apiError_('AGENCY_FORBIDDEN','ไม่มีสิทธิ์ดูรูปภาพของหน่วยงานนี้');
  var rows=readTable_('MediaAssets').filter(function(r){return (targetAgency==='*'&&isTrue_(user.is_super_admin)||r.agency_id===targetAgency)&&r.status==='ACTIVE'&&(!data.ownerId||r.owner_id===String(data.ownerId));});
  return paginate_(rows,data).map(function(r){delete r.delete_hash;return r;});
}

/* ========================================================================== */
/* 14. PASSWORD-PROTECTED PDF GENERATION                                      */
/* ========================================================================== */
function encryptAndStorePdf_(actor,data,context) {
  var pdfBase64=String(data.pdfBase64||'').replace(/^data:application\/pdf;base64,/,'');if(!pdfBase64)throw apiError_('PDF_REQUIRED','ไม่พบข้อมูล PDF');
  var sourceBytes=Utilities.base64Decode(pdfBase64);if(sourceBytes.length>APP.MAX_UPLOAD_BYTES)throw apiError_('PDF_TOO_LARGE','PDF มีขนาดเกินกำหนด');
  validateFileSignature_(sourceBytes,'application/pdf');
  var props=PropertiesService.getScriptProperties(),endpoint=props.getProperty(PROP.PDF_ENCRYPTION_ENDPOINT),apiKey=props.getProperty(PROP.PDF_ENCRYPTION_API_KEY);
  if(!endpoint||!apiKey)throw apiError_('PDF_ENCRYPTION_NOT_CONFIGURED','ยังไม่ได้กำหนดบริการ PDF Encryption ที่รองรับ AES-256 จึงไม่สร้างไฟล์แบบไม่มีรหัสผ่าน');
  var agencyId=isTrue_(actor.is_super_admin)?String(data.agencyId||''):actor.agency_id;if(!agencyId||agencyId==='*'||!getAgencyRecord_(agencyId))throw apiError_('AGENCY_REQUIRED','ต้องเลือกหน่วยงานสำหรับจัดเก็บ PDF');
  var password=generateUniqueFilePassword_(context),ownerPassword=secureRandomToken_(context,24),fileName=sanitizeFileName_(String(data.fileName||'document.pdf'));
  if(!/\.pdf$/i.test(fileName))fileName+='.pdf';
  var request={operation:'encrypt-pdf',algorithm:'AES-256',fileName:fileName,inputPdfBase64:pdfBase64,userPassword:password,ownerPassword:ownerPassword};
  var response=UrlFetchApp.fetch(endpoint,{method:'post',contentType:'application/json',headers:{'Authorization':'Bearer '+apiKey},payload:JSON.stringify(request),muteHttpExceptions:true});
  var code=response.getResponseCode(),result={};try{result=JSON.parse(response.getContentText());}catch(ignore){}
  if(code<200||code>=300||!result.ok||!result.encryptedPdfBase64||String(result.algorithm)!=='AES-256')throw apiError_('PDF_ENCRYPTION_FAILED','บริการเข้ารหัสไม่สามารถสร้าง PDF แบบ AES-256 ได้');
  var encryptedBytes=Utilities.base64Decode(String(result.encryptedPdfBase64));validateFileSignature_(encryptedBytes,'application/pdf');
  var folder=resolveAgencyFolder_(agencyId,'GeneratedPDF'),storedName=Utilities.getUuid()+'_'+fileName,driveFile=folder.createFile(Utilities.newBlob(encryptedBytes,'application/pdf',storedName));
  var attachment={attachment_id:generateId_('att'),agency_id:agencyId,book_type:'REPORT',book_id:String(data.bookId||''),assignment_id:'',drive_file_id:driveFile.getId(),drive_folder_id:folder.getId(),original_file_name:fileName,stored_file_name:storedName,file_extension:'pdf',mime_type:'application/pdf',size_bytes:encryptedBytes.length,checksum_sha256:sha256HexBytes_(encryptedBytes),category:'GENERATED_PDF',description:String(data.description||''),is_password_protected:true,status:'ACTIVE',uploaded_by:actor.user_id,uploaded_at:nowIso_(),updated_by:actor.user_id,updated_at:nowIso_(),deleted_at:''};
  appendRecord_('Attachments',attachment);
  appendRecord_('FilePasswordLogs',{file_password_log_id:generateId_('fpl'),agency_id:agencyId,user_id:actor.user_id,attachment_id:attachment.attachment_id,password_hash:hmacHex_(password,props.getProperty(PROP.PASSWORD_PEPPER)),password_algorithm:'HMAC-SHA256',file_name:fileName,purpose:String(data.purpose||'PDF_EXPORT'),created_at:nowIso_(),expires_at:'',status:'PASSWORD_DELIVERED_ONCE',request_id:context.requestId});
  appendRecord_('DownloadLogs',{download_id:generateId_('dl'),agency_id:agencyId,user_id:actor.user_id,attachment_id:attachment.attachment_id,drive_file_id_hash:sha256Hex_(driveFile.getId()),file_name:fileName,mime_type:'application/pdf',size_bytes:encryptedBytes.length,download_type:'GENERATED_PDF',request_id:context.requestId,downloaded_at:nowIso_(),status:'CREATED'});
  writeAudit_(actor,'pdf.encryptAndStore','pdf','Attachment',attachment.attachment_id,'สร้าง PDF เข้ารหัส AES-256',null,{fileName:fileName,algorithm:'AES-256'},context);
  return {attachmentId:attachment.attachment_id,fileName:fileName,mimeType:'application/pdf',sizeBytes:encryptedBytes.length,fileBase64:Utilities.base64Encode(encryptedBytes),maskedPassword:'********************',passwordForClipboard:password,passwordDelivery:'ONCE'};
}

/* ========================================================================== */
/* 15. LOOKUP TABLES: DOCUMENT TYPES AND BOOK CATEGORIES                      */
/* ========================================================================== */
function listLookupItems_(sheetName,user,data) {
  var targetAgency=String(data.agencyId||user.agency_id);if(!isTrue_(user.is_super_admin)&&targetAgency!==user.agency_id)throw apiError_('AGENCY_FORBIDDEN','ไม่มีสิทธิ์ดูรายการตั้งค่าของหน่วยงานนี้');
  var rows=readTable_(sheetName).filter(function(r){return r.agency_id==='*'||r.agency_id===targetAgency||r.agency_id===user.agency_id;});
  if(!data.includeInactive)rows=rows.filter(function(r){return isTrue_(r.is_active);});
  rows.sort(function(a,b){return Number(a.sort_order||0)-Number(b.sort_order||0);});return paginate_(rows,data);
}
function createLookupItem_(sheetName,actor,data,context) {
  var doc=sheetName==='DocumentTypes',code=String((doc?data.typeCode:data.categoryCode)||'').trim().toUpperCase(),name=String((doc?data.typeName:data.categoryName)||'').trim();
  if(!code||!name)throw apiError_('LOOKUP_FIELDS_REQUIRED','กรุณาระบุรหัสและชื่อรายการ');
  var agencyId=isTrue_(actor.is_super_admin)?String(data.agencyId||actor.agency_id):actor.agency_id,key=doc?'type_code':'category_code';if(!getAgencyRecord_(agencyId))throw apiError_('AGENCY_NOT_FOUND','ไม่พบหน่วยงาน');
  if(readTable_(sheetName).some(function(r){return (r.agency_id===agencyId||r.agency_id==='*')&&r[key]===code;}))throw apiError_('LOOKUP_CODE_EXISTS','รหัสนี้มีอยู่แล้ว');
  var now=nowIso_(),r=doc?{document_type_id:generateId_('dtp'),agency_id:agencyId,type_code:code,type_name:name,description:String(data.description||''),default_prefix:String(data.defaultPrefix||''),sort_order:Number(data.sortOrder)||0,is_active:true,created_by:actor.user_id,created_at:now,updated_by:actor.user_id,updated_at:now}:{category_id:generateId_('cat'),agency_id:agencyId,category_code:code,category_name:name,description:String(data.description||''),sort_order:Number(data.sortOrder)||0,is_active:true,created_by:actor.user_id,created_at:now,updated_by:actor.user_id,updated_at:now};
  appendRecord_(sheetName,r);writeAudit_(actor,doc?'documentTypes.create':'categories.create','settings',sheetName,doc?r.document_type_id:r.category_id,'เพิ่มรายการ '+name,null,r,context);return r;
}
function updateLookupItem_(sheetName,actor,data,context) {
  var doc=sheetName==='DocumentTypes',id=String(data.id||(doc?data.documentTypeId:data.categoryId)||''),key=doc?'document_type_id':'category_id',old=getRecordById_(sheetName,key,id);if(!old)throw apiError_('LOOKUP_NOT_FOUND','ไม่พบรายการ');assertSameAgencyOrSuper_(actor,old.agency_id);
  var patch={updated_by:actor.user_id,updated_at:nowIso_()};if(data.name!==undefined)patch[doc?'type_name':'category_name']=String(data.name);if(data.description!==undefined)patch.description=String(data.description);if(data.sortOrder!==undefined)patch.sort_order=Number(data.sortOrder);if(data.isActive!==undefined)patch.is_active=!!data.isActive;if(doc&&data.defaultPrefix!==undefined)patch.default_prefix=String(data.defaultPrefix);
  updateRecord_(sheetName,key,id,patch);writeAudit_(actor,doc?'documentTypes.update':'categories.update','settings',sheetName,id,'แก้ไขรายการ',old,patch,context);return getRecordById_(sheetName,key,id);
}

/* ========================================================================== */
/* 16. REPORTS AND REGISTRY REPORT DATA                                       */
/* ========================================================================== */
function getReportSummary_(user,data) {
  var agencyId=String(data.agencyId||user.agency_id);if(!isTrue_(user.is_super_admin)&&agencyId!==user.agency_id)throw apiError_('AGENCY_FORBIDDEN','ไม่มีสิทธิ์ดูรายงานหน่วยงานนี้');
  var incoming=readTable_('IncomingBooks').filter(function(r){return r.agency_id===agencyId&&!r.deleted_at;}),outgoing=readTable_('OutgoingBooks').filter(function(r){return r.agency_id===agencyId&&!r.deleted_at;}),assign=readTable_('Assignments').filter(function(r){return r.agency_id===agencyId;});
  var year=String(data.year||getFiscalYearForAgency_(today_(),getAgencyRecord_(agencyId)));
  var inYear=incoming.filter(function(r){return String(r.registration_year)===year;}),outYear=outgoing.filter(function(r){return String(r.registration_year)===year;});
  var monthCounts={};for(var m=1;m<=12;m++)monthCounts[String(m).padStart(2,'0')]={incoming:0,outgoing:0};
  inYear.forEach(function(r){var d=new Date(r.received_date);if(!isNaN(d.getTime()))monthCounts[monthKeyFromDate_(d)].incoming++;});
  outYear.forEach(function(r){var d=new Date(r.sent_date);if(!isNaN(d.getTime()))monthCounts[monthKeyFromDate_(d)].outgoing++;});
  return {agencyId:agencyId,fiscalYear:year,incomingTotal:inYear.length,outgoingTotal:outYear.length,pendingAssignments:assign.filter(function(r){return ['PENDING','IN_PROGRESS'].indexOf(r.status)>=0;}).length,completedAssignments:assign.filter(function(r){return r.status==='COMPLETED';}).length,overdueAssignments:assign.filter(function(r){return r.due_at&&String(r.due_at).slice(0,10)<today_()&&r.status!=='COMPLETED'&&r.status!=='CANCELLED';}).length,pendingIncoming:inYear.filter(function(r){return ['RECEIVED','PENDING','IN_PROGRESS'].indexOf(r.status)>=0;}).length,monthly:monthCounts,priorityBreakdown:countBy_(inYear.concat(outYear),'priority_level'),statusIncoming:countBy_(inYear,'status'),statusOutgoing:countBy_(outYear,'status')};
}
function getRegistryReportData_(user,data) {
  var type=String(data.bookType||'INCOMING').toUpperCase(),sheet=type==='INCOMING'?'IncomingBooks':type==='OUTGOING'?'OutgoingBooks':'';if(!sheet)throw apiError_('BOOK_TYPE_INVALID','ประเภททะเบียนไม่ถูกต้อง');
  var agencyId=String(data.agencyId||user.agency_id);if(!isTrue_(user.is_super_admin)&&agencyId!==user.agency_id)throw apiError_('AGENCY_FORBIDDEN','ไม่มีสิทธิ์ออกรายงานของหน่วยงานนี้');
  var rows=readTable_(sheet).filter(function(r){return r.agency_id===agencyId&&!r.deleted_at;});
  if(data.year)rows=rows.filter(function(r){return String(r.registration_year)===String(data.year);});
  if(data.dateFrom||data.dateTo)rows=rows.filter(function(r){var d=String(r.received_date||r.sent_date);return (!data.dateFrom||d>=data.dateFrom)&&(!data.dateTo||d<=data.dateTo);});
  if(data.status)rows=rows.filter(function(r){return r.status===data.status;});
  rows.sort(function(a,b){return Number(a.sequence_no)-Number(b.sequence_no);});
  var max=Math.min(Math.max(Number(data.limit)||500,1),5000);if(rows.length>max)rows=rows.slice(0,max);
  var agency=getAgencyRecord_(agencyId);
  return {bookType:type,agency:publicAgency_(agency),reportTitle:type==='INCOMING'?'ทะเบียนหนังสือรับ':'ทะเบียนหนังสือส่ง',fiscalYear:data.year||getFiscalYearForAgency_(today_(),agency),generatedAt:nowIso_(),total:rows.length,truncated:rows.length===max,rows:rows.map(publicBook_)};
}

function globalSearch_(user,data) {
  var q=String(data.query||'').trim().toLowerCase();if(q.length<2)throw apiError_('SEARCH_QUERY_TOO_SHORT','คำค้นหาต้องมีอย่างน้อย 2 ตัวอักษร');
  var limit=Math.min(Math.max(Number(data.limit)||30,1),100),results=[];
  if(hasPermission_(user,'incoming.read'))readTable_('IncomingBooks').forEach(function(r){if(r.deleted_at||(!isTrue_(user.is_super_admin)&&r.agency_id!==user.agency_id))return;var text=[r.registration_no,r.document_number,r.subject,r.sender_name,r.sender_agency].join(' ').toLowerCase();if(text.indexOf(q)>=0)results.push({bookType:'INCOMING',agencyId:r.agency_id,book:publicBook_(r)});});
  if(hasPermission_(user,'outgoing.read'))readTable_('OutgoingBooks').forEach(function(r){if(r.deleted_at||(!isTrue_(user.is_super_admin)&&r.agency_id!==user.agency_id))return;var text=[r.registration_no,r.document_number,r.subject,r.recipient_name,r.recipient_agency].join(' ').toLowerCase();if(text.indexOf(q)>=0)results.push({bookType:'OUTGOING',agencyId:r.agency_id,book:publicBook_(r)});});
  results.sort(function(a,b){return String(b.book.createdAt||'').localeCompare(String(a.book.createdAt||''));});return {query:q,total:results.length,results:results.slice(0,limit)};
}
function getGlobalReportSummary_(data) {
  var agencies=readTable_('Agencies').filter(function(a){return a.status==='ACTIVE'&&!a.deleted_at;}),out=[];
  var allIncoming=readTable_('IncomingBooks'),allOutgoing=readTable_('OutgoingBooks'),allUsers=readTable_('Users');
  agencies.forEach(function(a){var inc=allIncoming.filter(function(r){return r.agency_id===a.agency_id&&!r.deleted_at;}),sent=allOutgoing.filter(function(r){return r.agency_id===a.agency_id&&!r.deleted_at;}),year=String(data.year||getFiscalYearForAgency_(today_(),a));out.push({agencyId:a.agency_id,agencyCode:a.agency_code,agencyName:a.agency_name,fiscalYear:year,incoming:inc.filter(function(r){return String(r.registration_year)===year;}).length,outgoing:sent.filter(function(r){return String(r.registration_year)===year;}).length,users:allUsers.filter(function(r){return r.agency_id===a.agency_id&&r.status==='ACTIVE'&&!r.deleted_at;}).length});});
  return {fiscalYear:String(data.year||getThaiFiscalYear_()),agencyCount:agencies.length,agencies:out,totalIncoming:out.reduce(function(s,r){return s+r.incoming;},0),totalOutgoing:out.reduce(function(s,r){return s+r.outgoing;},0)};
}

/* ========================================================================== */
/* 17. NOTIFICATIONS                                                          */
/* ========================================================================== */
function createNotification_(agencyId,userId,type,title,message,refType,refId,targetUrl) {
  if(!userId)return null;var n={notification_id:generateId_('ntf'),agency_id:agencyId,user_id:userId,notification_type:type,title:title,message:message,reference_type:refType,reference_id:refId,target_url:targetUrl||'',is_read:false,read_at:'',created_at:nowIso_(),expires_at:''};appendRecord_('Notifications',n);return n;
}
function listNotifications_(user,data) {
  var targetAgency=String(data.agencyId||user.agency_id);if(!isTrue_(user.is_super_admin)&&targetAgency!==user.agency_id)throw apiError_('AGENCY_FORBIDDEN','ไม่มีสิทธิ์ดูการแจ้งเตือนของหน่วยงานนี้');
  var rows=readTable_('Notifications').filter(function(r){return (targetAgency==='*'&&isTrue_(user.is_super_admin)||r.agency_id===targetAgency)&&(r.user_id===user.user_id||r.user_id==='*'||isTrue_(user.is_super_admin));});
  if(data.unreadOnly)rows=rows.filter(function(r){return !isTrue_(r.is_read);});
  return paginate_(rows.sort(function(a,b){return String(b.created_at).localeCompare(String(a.created_at));}),data);
}
function markNotificationRead_(user,data,context) {
  var id=String(data.notificationId||''),n=getRecordById_('Notifications','notification_id',id);if(!n)throw apiError_('NOTIFICATION_NOT_FOUND','ไม่พบการแจ้งเตือน');
  if(n.agency_id!==user.agency_id||n.user_id!==user.user_id&&!isTrue_(user.is_super_admin))throw apiError_('FORBIDDEN','ไม่มีสิทธิ์เปลี่ยนสถานะการแจ้งเตือนนี้');
  updateRecord_('Notifications','notification_id',id,{is_read:true,read_at:nowIso_()});return {read:true};
}

/* ========================================================================== */
/* 18. AGENCY SETTINGS                                                        */
/* ========================================================================== */
function getAgencySettings_(user,data) {
  var agency=getAgencyRecord_(String(data.agencyId||user.agency_id));if(!agency)throw apiError_('AGENCY_NOT_FOUND','ไม่พบหน่วยงาน');assertSameAgencyOrSuper_(user,agency.agency_id);
  var settings={};try{settings=JSON.parse(agency.settings_json||'{}');}catch(ignore){}
  return {agency:publicAgency_(agency),settings:settings,system:{name:APP.NAME,version:APP.VERSION,timezone:APP.TIMEZONE,pdfFont:'TH Sarabun New',pdfPaper:'A4',pdfOrientation:'landscape'}};
}
function updateAgencySettings_(actor,data,context) {
  var id=String(data.agencyId||actor.agency_id),agency=getAgencyRecord_(id);if(!agency)throw apiError_('AGENCY_NOT_FOUND','ไม่พบหน่วยงาน');assertSameAgencyOrSuper_(actor,id);
  if(!data.settings||typeof data.settings!=='object')throw apiError_('SETTINGS_REQUIRED','ต้องส่ง settings เป็น Object');
  var allowed=['defaultPriority','defaultConfidentiality','incomingPrefix','outgoingPrefix','fiscalYearStartMonth','pdfFont','pdfOrientation','notificationEmail','workflowStatuses','requireAttachmentForIncoming'];
  var clean={};allowed.forEach(function(k){if(data.settings[k]!==undefined)clean[k]=data.settings[k];});
  var patch={settings_json:JSON.stringify(clean),updated_by:actor.user_id,updated_at:nowIso_()};if(clean.incomingPrefix!==undefined)patch.incoming_prefix=String(clean.incomingPrefix);if(clean.outgoingPrefix!==undefined)patch.outgoing_prefix=String(clean.outgoingPrefix);if(clean.fiscalYearStartMonth!==undefined)patch.fiscal_year_start_month=Number(clean.fiscalYearStartMonth);
  updateRecord_('Agencies','agency_id',id,patch);writeAudit_(actor,'settings.update','settings','Agency',id,'ปรับปรุงการตั้งค่าหน่วยงาน',null,clean,context);return getAgencySettings_(actor,{agencyId:id});
}

/* ========================================================================== */
/* 19. AUDIT LOGS AND DOWNLOAD HISTORY                                        */
/* ========================================================================== */
function listAuditLogs_(user,data) {
  var rows=readTable_('AuditLogs').filter(function(r){return isTrue_(user.is_super_admin)||r.agency_id===user.agency_id;});
  if(data.userId)rows=rows.filter(function(r){return r.user_id===String(data.userId);});if(data.module)rows=rows.filter(function(r){return r.module===String(data.module);});if(data.action)rows=rows.filter(function(r){return r.action===String(data.action);});
  if(data.dateFrom)rows=rows.filter(function(r){return r.created_at>=data.dateFrom;});if(data.dateTo)rows=rows.filter(function(r){return r.created_at<=data.dateTo+'T23:59:59';});
  return paginate_(rows.sort(function(a,b){return String(b.created_at).localeCompare(String(a.created_at));}),data,APP.MAX_AUDIT_LIST);
}
function listDownloadLogs_(user,data) {
  var rows=readTable_('DownloadLogs').filter(function(r){return isTrue_(user.is_super_admin)||r.agency_id===user.agency_id;});
  if(data.userId)rows=rows.filter(function(r){return r.user_id===String(data.userId);});if(data.dateFrom)rows=rows.filter(function(r){return r.downloaded_at>=data.dateFrom;});if(data.dateTo)rows=rows.filter(function(r){return r.downloaded_at<=data.dateTo+'T23:59:59';});
  return paginate_(rows.sort(function(a,b){return String(b.downloaded_at).localeCompare(String(a.downloaded_at));}),data,APP.MAX_AUDIT_LIST);
}
function writeAudit_(actor,action,module,entityType,entityId,description,beforeValue,afterValue,context) {
  try {
    var a={audit_id:generateId_('aud'),agency_id:context&&context.agencyId||actor&&actor.agency_id||'',user_id:actor&&actor.user_id||'',username:actor&&actor.username||'SYSTEM',action:action,module:module,entity_type:entityType,entity_id:entityId,description:String(description||''),before_json:safeAuditJson_(beforeValue),after_json:safeAuditJson_(afterValue),request_id:context&&context.requestId||'',ip_hint:context&&context.ipHint||'',user_agent:context&&context.userAgent||'',created_at:nowIso_()};appendRecord_('AuditLogs',a);
  } catch(err) {console.error('Audit log write failed: '+err);}
}
function safeAuditJson_(value) {
  if(value===null||value===undefined)return '';
  var clone=JSON.parse(JSON.stringify(value));var forbidden=/password|token|secret|hash|salt|fileBase64|drive_file_id|delete_hash/i;
  function scrub(x){if(Array.isArray(x))return x.map(scrub);if(x&&typeof x==='object'){Object.keys(x).forEach(function(k){if(forbidden.test(k))delete x[k];else x[k]=scrub(x[k]);});}return x;}
  return JSON.stringify(scrub(clone)).slice(0,20000);
}

/* ========================================================================== */
/* 20. BACKUP AND RESTORE                                                     */
/* ========================================================================== */
function createBackup_(actor,data,context) {
  requireSuperAdmin_(actor);var ss=getSpreadsheet_(),payload={backupVersion:1,application:APP.NAME,createdAt:nowIso_(),spreadsheetId:ss.getId(),tables:{}};
  var total=0;Object.keys(DB_SCHEMA).forEach(function(name){var rows=readTable_(name);total+=rows.length;if(total>APP.MAX_BACKUP_ROWS)throw apiError_('BACKUP_ROW_LIMIT','จำนวนแถวเกินขีดจำกัดการสำรองข้อมูล');payload.tables[name]=rows;});
  var json=JSON.stringify(payload),folder=resolveRootFolder_('Backups'),name='backup_'+Utilities.formatDate(new Date(),APP.TIMEZONE,'yyyyMMdd_HHmmss')+'.json',file=folder.createFile(name,json,MimeType.PLAIN_TEXT);
  var row={backup_id:generateId_('bkp'),agency_id:'*',drive_file_id:file.getId(),file_name:name,size_bytes:Utilities.newBlob(json).getBytes().length,backup_type:'FULL_JSON',row_count:total,status:'COMPLETED',created_by:actor.user_id,created_at:nowIso_(),restored_by:'',restored_at:'',notes:String(data.notes||'')};appendRecord_('BackupLogs',row);writeAudit_(actor,'backup.create','backup','Backup',row.backup_id,'สร้างข้อมูลสำรอง',null,{fileName:name,rowCount:total},context);return {backupId:row.backup_id,fileName:name,rowCount:total,createdAt:row.created_at};
}
function listBackups_(actor,data) {
  requireSuperAdmin_(actor);return paginate_(readTable_('BackupLogs').sort(function(a,b){return String(b.created_at).localeCompare(String(a.created_at));}),data);
}
function restoreBackup_(actor,data,context) {
  requireSuperAdmin_(actor);if(String(data.confirmation||'')!=='RESTORE ALL DATA')throw apiError_('RESTORE_CONFIRMATION_REQUIRED','กรุณายืนยันด้วยข้อความ RESTORE ALL DATA');
  var id=String(data.backupId||''),b=getRecordById_('BackupLogs','backup_id',id);if(!b)throw apiError_('BACKUP_NOT_FOUND','ไม่พบข้อมูลสำรอง');
  var file=DriveApp.getFileById(b.drive_file_id),backup=JSON.parse(file.getBlob().getDataAsString('UTF-8'));if(!backup.tables)throw apiError_('BACKUP_INVALID','ไฟล์สำรองไม่มีข้อมูลตาราง');
  if(Number(backup.backupVersion)!==1)throw apiError_('BACKUP_VERSION_UNSUPPORTED','ไม่รองรับเวอร์ชันไฟล์สำรองนี้');
  var ss=getSpreadsheet_();Object.keys(DB_SCHEMA).forEach(function(name){if(!backup.tables[name])return;var sheet=ss.getSheetByName(name);if(!sheet)sheet=ensureSheetSchema_(ss,name,DB_SCHEMA[name]);var values=backup.tables[name].map(function(r){var copy={};Object.keys(r).forEach(function(k){copy[k]=r[k];});if(name==='Sessions'){copy.status='REVOKED';copy.revoked_at=nowIso_();}if(name==='PasswordResetTokens'){copy.status='REVOKED';}return copy;});sheet.clearContents();sheet.getRange(1,1,1,DB_SCHEMA[name].length).setValues([DB_SCHEMA[name]]);if(values.length){var output=values.map(function(r){return DB_SCHEMA[name].map(function(h){return r[h]===undefined?'':r[h];});});sheet.getRange(2,1,output.length,DB_SCHEMA[name].length).setValues(output);}});
  var restoredLog=getRecordById_('BackupLogs','backup_id',id);
  if(restoredLog)updateRecord_('BackupLogs','backup_id',id,{restored_by:actor.user_id,restored_at:nowIso_(),status:'RESTORED'});
  else {var retained={};Object.keys(b).forEach(function(k){retained[k]=b[k];});retained.restored_by=actor.user_id;retained.restored_at=nowIso_();retained.status='RESTORED';appendRecord_('BackupLogs',retained);}
  writeAudit_(actor,'backup.restore','backup','Backup',id,'กู้คืนข้อมูลทั้งหมดจาก Backup',null,{backupId:id},context);return {restored:true,backupId:id};
}

/* ========================================================================== */
/* 21. DATABASE ACCESS LAYER                                                  */
/* ========================================================================== */
function getAgencyRecord_(agencyId) { return getRecordById_('Agencies','agency_id',String(agencyId||'')); }

function generateUniqueFilePassword_(context) {
  var pepper=PropertiesService.getScriptProperties().getProperty(PROP.PASSWORD_PEPPER);
  if(!pepper)throw apiError_('PASSWORD_PEPPER_NOT_CONFIGURED','ยังไม่ได้กำหนด PASSWORD_PEPPER');
  var existing={};readTable_('FilePasswordLogs').forEach(function(r){if(r.password_hash)existing[String(r.password_hash)]=true;});
  for(var attempt=0;attempt<12;attempt++){var candidate=secureRandomToken_(context,20),digest=hmacHex_(candidate,pepper);if(!existing[digest])return candidate;}
  throw apiError_('PASSWORD_GENERATION_FAILED','ไม่สามารถสร้างรหัสผ่านไฟล์ที่ไม่ซ้ำได้');
}

function requireDatabase_() {
  var id=PropertiesService.getScriptProperties().getProperty(PROP.SPREADSHEET_ID);
  if(!id)throw apiError_('DATABASE_NOT_INITIALIZED','ยังไม่ได้สร้างฐานข้อมูล กรุณารัน initializeSystem() ก่อน');
  return true;
}
function getSpreadsheet_() {
  var id=PropertiesService.getScriptProperties().getProperty(PROP.SPREADSHEET_ID);if(!id)throw apiError_('DATABASE_NOT_INITIALIZED','ยังไม่ได้กำหนด SPREADSHEET_ID');
  return SpreadsheetApp.openById(id);
}
function readTable_(name) {
  if(!DB_SCHEMA[name])throw apiError_('TABLE_NOT_ALLOWED','ไม่อนุญาตให้เข้าถึงตารางนี้');
  var sheet=getSpreadsheet_().getSheetByName(name);if(!sheet)return [];
  var values=sheet.getDataRange().getValues();if(values.length<2)return [];
  var headers=values[0].map(function(h){return String(h||'');});
  return values.slice(1).filter(function(row){return row.some(function(v){return v!==''&&v!==null;});}).map(function(row){var obj={};headers.forEach(function(h,i){if(h)obj[h]=normalizeCellValue_(row[i]);});return obj;});
}
function appendRecord_(name,record) {
  var sheet=getSpreadsheet_().getSheetByName(name);if(!sheet)throw apiError_('TABLE_NOT_FOUND','ไม่พบตาราง '+name);
  var headers=sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0].map(String);
  var row=headers.map(function(h){var v=record[h];return safeSheetValue_(v===undefined||v===null?'':v);});
  sheet.getRange(sheet.getLastRow()+1,1,1,headers.length).setValues([row]);return record;
}
function updateRecord_(name,keyField,keyValue,patch) {
  var sheet=getSpreadsheet_().getSheetByName(name);if(!sheet)throw apiError_('TABLE_NOT_FOUND','ไม่พบตาราง '+name);
  var range=sheet.getDataRange(),values=range.getValues();if(values.length<2)throw apiError_('RECORD_NOT_FOUND','ไม่พบข้อมูล');
  var headers=values[0].map(String),keyIndex=headers.indexOf(keyField);if(keyIndex<0)throw apiError_('SCHEMA_ERROR','ไม่พบคอลัมน์ '+keyField);
  var rowIndex=-1;for(var i=1;i<values.length;i++){if(String(values[i][keyIndex])===String(keyValue)){rowIndex=i+1;break;}}
  if(rowIndex<0)throw apiError_('RECORD_NOT_FOUND','ไม่พบข้อมูล');
  var indexes={};headers.forEach(function(h,i){indexes[h]=i+1;});
  Object.keys(patch).forEach(function(k){if(indexes[k])sheet.getRange(rowIndex,indexes[k]).setValue(safeSheetValue_(patch[k]===undefined?'':patch[k]));});
  return getRecordById_(name,keyField,keyValue);
}
function deleteRecord_(name,keyField,keyValue) {
  var sheet=getSpreadsheet_().getSheetByName(name),values=sheet.getDataRange().getValues(),idx=values[0].map(String).indexOf(keyField);if(idx<0)return false;
  for(var i=1;i<values.length;i++){if(String(values[i][idx])===String(keyValue)){sheet.deleteRow(i+1);return true;}}return false;
}
function getRecordById_(name,keyField,keyValue) {
  if(keyValue===undefined||keyValue===null||keyValue==='')return null;
  var rows=readTable_(name);for(var i=0;i<rows.length;i++){if(String(rows[i][keyField])===String(keyValue))return rows[i];}return null;
}
function findOne_(name,predicate) {var rows=readTable_(name);for(var i=0;i<rows.length;i++)if(predicate(rows[i]))return rows[i];return null;}
function upsertByField_(name,keyField,keyValue,record) {
  var old=getRecordById_(name,keyField,keyValue);if(old){updateRecord_(name,keyField,keyValue,record);return record;}return appendRecord_(name,record);
}
function normalizeCellValue_(value) {if(value instanceof Date)return Utilities.formatDate(value,APP.TIMEZONE,"yyyy-MM-dd'T'HH:mm:ss");return value;}
function safeSheetValue_(value) {if(typeof value==='string'&&/^[=+@\-]/.test(value))return '\''+value;return value;}

/* ========================================================================== */
/* 22. DRIVE FOLDER MANAGEMENT                                                */
/* ========================================================================== */
function ensureRootDriveFolder_() {
  var props=PropertiesService.getScriptProperties(),id=props.getProperty(PROP.DRIVE_ROOT_FOLDER_ID),folder=null;
  if(id){try{folder=DriveApp.getFolderById(id);folder.getName();}catch(ignore){folder=null;}}
  if(!folder){folder=DriveApp.createFolder(APP.DRIVE_ROOT_FOLDER_NAME+'_'+Utilities.formatDate(new Date(),APP.TIMEZONE,'yyyyMMdd_HHmmss'));props.setProperty(PROP.DRIVE_ROOT_FOLDER_ID,folder.getId());}
  try{folder.setSharing(DriveApp.Access.PRIVATE,DriveApp.Permission.VIEW);}catch(shareError){console.warn('Could not enforce Drive root sharing: '+shareError);}
  return folder;
}
function ensureAgencyDriveFolders_(agencyId,agencyName) {
  var root=ensureRootDriveFolder_(),it=root.getFoldersByName('Agency_'+slug_(agencyId)),agencyFolder=it.hasNext()?it.next():root.createFolder('Agency_'+slug_(agencyId));
  APP.DRIVE_AGENCY_FOLDERS.forEach(function(name){var f=agencyFolder.getFoldersByName(name);if(!f.hasNext())agencyFolder.createFolder(name);});
  var index=findOne_('DriveFolderIndex',function(r){return r.agency_id===agencyId&&r.folder_type==='ROOT';});
  if(!index)appendRecord_('DriveFolderIndex',{folder_index_id:generateId_('dfi'),agency_id:agencyId,folder_type:'ROOT',drive_folder_id:agencyFolder.getId(),folder_name:'Agency_'+slug_(agencyId),created_at:nowIso_()});
  return {root:agencyFolder.getId(),name:agencyName};
}
function resolveAgencyFolder_(agencyId,folderType) {
  var mapping={Incoming:'Incoming',Outgoing:'Outgoing',Attachments:'Attachments',GeneratedPDF:'GeneratedPDF',Backups:'Backups'};var name=mapping[folderType]||'Attachments';
  var root=ensureRootDriveFolder_(),agencyFolder=null,agencyIndex=findOne_('DriveFolderIndex',function(r){return r.agency_id===agencyId&&r.folder_type==='ROOT';});
  if(agencyIndex){try{agencyFolder=DriveApp.getFolderById(agencyIndex.drive_folder_id);}catch(ignore){agencyFolder=null;}}
  if(!agencyFolder){var it=root.getFoldersByName('Agency_'+slug_(agencyId));agencyFolder=it.hasNext()?it.next():root.createFolder('Agency_'+slug_(agencyId));appendRecord_('DriveFolderIndex',{folder_index_id:generateId_('dfi'),agency_id:agencyId,folder_type:'ROOT',drive_folder_id:agencyFolder.getId(),folder_name:agencyFolder.getName(),created_at:nowIso_()});}
  var children=agencyFolder.getFoldersByName(name),folder=children.hasNext()?children.next():agencyFolder.createFolder(name);
  if(!findOne_('DriveFolderIndex',function(r){return r.agency_id===agencyId&&r.folder_type===name;}))appendRecord_('DriveFolderIndex',{folder_index_id:generateId_('dfi'),agency_id:agencyId,folder_type:name,drive_folder_id:folder.getId(),folder_name:name,created_at:nowIso_()});
  return folder;
}
function resolveRootFolder_(name) {var root=ensureRootDriveFolder_(),it=root.getFoldersByName(name);return it.hasNext()?it.next():root.createFolder(name);}

/* ========================================================================== */
/* 23. AUTHORIZATION AND TENANT ISOLATION                                     */
/* ========================================================================== */
function requireSuperAdmin_(user) {if(!isTrue_(user&&user.is_super_admin))throw apiError_('SUPER_ADMIN_REQUIRED','คำสั่งนี้อนุญาตเฉพาะผู้ดูแลระบบส่วนกลาง');}
function assertSameAgencyOrSuper_(user,agencyId) {if(!isTrue_(user&&user.is_super_admin)&&String(user.agency_id)!==String(agencyId))throw apiError_('AGENCY_FORBIDDEN','ไม่มีสิทธิ์เข้าถึงข้อมูลหน่วยงานนี้');}
function hasPermission_(user,permission) {if(isTrue_(user.is_super_admin))return true;var role=getRecordById_('Roles','role_id',user.role_id);if(!role||!isTrue_(role.is_active))return false;var codes=getRolePermissionCodes_(user.role_id);return codes.indexOf('*')>=0||codes.indexOf(permission)>=0;}
function assertPermission_(user,permission,agencyId) {
  if(isTrue_(user.is_super_admin))return true;
  if(String(user.agency_id)!==String(agencyId))throw apiError_('AGENCY_FORBIDDEN','ไม่มีสิทธิ์เข้าถึงหน่วยงานนี้');
  if(!hasPermission_(user,permission))throw apiError_('PERMISSION_DENIED','คุณไม่มีสิทธิ์ดำเนินการนี้');
  return true;
}

/* ========================================================================== */
/* 24. PUBLIC SERIALIZERS                                                     */
/* ========================================================================== */
function publicAgency_(a) {
  if(!a)return null;return {agencyId:a.agency_id,agencyCode:a.agency_code,agencyName:a.agency_name,shortName:a.agency_short_name,agencyType:a.agency_type,parentAgencyId:a.parent_agency_id,logoUrl:a.logo_url,address:a.address,village:a.village,building:a.building,street:a.street,subdistrict:a.subdistrict,district:a.district,province:a.province,postalCode:a.postal_code,phone:a.phone,fax:a.fax,email:a.email,website:a.website,timezone:a.timezone,fiscalYearStartMonth:a.fiscal_year_start_month,incomingPrefix:a.incoming_prefix,outgoingPrefix:a.outgoing_prefix,currentFiscalYear:a.current_fiscal_year,driveFolderConfigured:!!a.drive_folder_id,status:a.status};
}
function publicUser_(u) {
  if(!u)return null;return {userId:u.user_id,agencyId:u.agency_id,username:u.username,displayName:u.display_name,firstName:u.first_name,lastName:u.last_name,email:u.email,phone:u.phone,position:u.position,departmentId:u.department_id,roleId:u.role_id,isSuperAdmin:isTrue_(u.is_super_admin),status:u.status,mustChangePassword:isTrue_(u.must_change_password),lastLoginAt:u.last_login_at,avatarUrl:u.avatar_url,notificationPreferences:(function(){try{return JSON.parse(u.notification_preferences_json||'{}');}catch(e){return {};}})()};
}
function publicBook_(r) {
  var out={};Object.keys(r||{}).forEach(function(k){out[k]=r[k];});delete out.deleted_at;
  var map={book_id:'bookId',agency_id:'agencyId',registration_no:'registrationNo',registration_year:'registrationYear',sequence_no:'sequenceNo',received_date:'receivedDate',sent_date:'sentDate',document_number:'documentNumber',document_date:'documentDate',sender_name:'senderName',sender_agency:'senderAgency',sender_address:'senderAddress',sender_contact:'senderContact',recipient_name:'recipientName',recipient_position:'recipientPosition',recipient_agency:'recipientAgency',recipient_address:'recipientAddress',recipient_contact:'recipientContact',document_type_id:'documentTypeId',category_id:'categoryId',priority_level:'priorityLevel',confidentiality_level:'confidentialityLevel',signatory_user_id:'signatoryUserId',signatory_name:'signatoryName',signatory_position:'signatoryPosition',department_id:'departmentId',responsible_user_id:'responsibleUserId',due_date:'dueDate',received_channel:'receivedChannel',sent_channel:'sentChannel',tracking_number:'trackingNumber',parent_book_id:'parentBookId',related_incoming_book_id:'relatedIncomingBookId',external_reference:'externalReference',primary_attachment_id:'primaryAttachmentId',attachment_count:'attachmentCount',tags_json:'tags',created_by:'createdBy',created_at:'createdAt',updated_by:'updatedBy',updated_at:'updatedAt'};
  Object.keys(map).forEach(function(k){out[map[k]]=out[k];delete out[k];});try{out.tags=JSON.parse(out.tags||'[]');}catch(ignore){out.tags=[];}return out;
}
function publicAttachment_(r) {return {attachmentId:r.attachment_id,agencyId:r.agency_id,bookType:r.book_type,bookId:r.book_id,assignmentId:r.assignment_id,fileName:r.original_file_name,fileExtension:r.file_extension,mimeType:r.mime_type,sizeBytes:Number(r.size_bytes)||0,checksumSha256:r.checksum_sha256,category:r.category,description:r.description,isPasswordProtected:isTrue_(r.is_password_protected),status:r.status,uploadedBy:r.uploaded_by,uploadedAt:r.uploaded_at};}

/* ========================================================================== */
/* 25. SYSTEM STATUS                                                          */
/* ========================================================================== */
function getSystemStatus_(actor) {
  requireSuperAdmin_(actor);var counts={};Object.keys(DB_SCHEMA).forEach(function(name){counts[name]=Math.max(0,getSpreadsheet_().getSheetByName(name).getLastRow()-1);});
  return {application:APP.NAME,version:APP.VERSION,initialized:PropertiesService.getScriptProperties().getProperty(PROP.SYSTEM_INITIALIZED)==='true',spreadsheetId:getSpreadsheet_().getId(),spreadsheetName:getSpreadsheet_().getName(),agencyCount:counts.Agencies||0,userCount:counts.Users||0,tableCounts:counts,driveRootConfigured:!!PropertiesService.getScriptProperties().getProperty(PROP.DRIVE_ROOT_FOLDER_ID),imgbbConfigured:!!PropertiesService.getScriptProperties().getProperty(PROP.IMGBB_API_KEY),pdfEncryptionConfigured:!!PropertiesService.getScriptProperties().getProperty(PROP.PDF_ENCRYPTION_ENDPOINT),gatewayConfigured:!!PropertiesService.getScriptProperties().getProperty(PROP.GATEWAY_SHARED_SECRET),timestamp:nowIso_()};
}

/* ========================================================================== */
/* 26. GENERAL UTILITIES                                                      */
/* ========================================================================== */
var SECURE_RANDOM_COUNTER_=0;
function generateId_(prefix) {return String(prefix||'id')+'_'+Utilities.getUuid().replace(/-/g,'').toLowerCase();}
function uuidHex_() {return (Utilities.getUuid()+Utilities.getUuid()).replace(/-/g,'').toLowerCase();}
function secureRandomToken_(context,byteLength) {
  var length=Math.max(8,Number(byteLength)||16),hex='';
  if(context&&/^[a-fA-F0-9]{512,4096}$/.test(String(context.secureRandomHex||''))) {
    SECURE_RANDOM_COUNTER_++;
    var seed=hexToBytes_(String(context.secureRandomHex).slice(0,512));
    var material=Utilities.newBlob(String(context.requestId||'')+':'+SECURE_RANDOM_COUNTER_+':'+Utilities.getUuid()).getBytes();
    var block=Utilities.computeHmacSha256Signature(material,seed);
    while(hex.length<length*2){hex+=bytesToHex_(block);block=Utilities.computeHmacSha256Signature(block,seed);}
    return hex.slice(0,length*2);
  }
  while(hex.length<length*2)hex+=uuidHex_();
  return hex.slice(0,length*2);
}
function sha256Hex_(value) {return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,String(value),Utilities.Charset.UTF_8));}
function sha256HexBytes_(bytes) {return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,bytes));}
function hmacHex_(value,key) {return bytesToHex_(Utilities.computeHmacSha256Signature(String(value),String(key),Utilities.Charset.UTF_8));}
function bytesToHex_(bytes) {return (bytes||[]).map(function(b){return ((b+256)%256).toString(16).padStart(2,'0');}).join('');}
function hexToBytes_(hex) {var out=[];for(var i=0;i<hex.length;i+=2)out.push(parseInt(hex.substr(i,2),16));return out;}
function concatBytes_(a,b) {return (a||[]).concat(b||[]);}
function constantTimeEquals_(a,b) {
  a=String(a||'');b=String(b||'');var diff=a.length^b.length,max=Math.max(a.length,b.length);
  for(var i=0;i<max;i++)diff|=(a.charCodeAt(i%Math.max(1,a.length))||0)^(b.charCodeAt(i%Math.max(1,b.length))||0);
  return diff===0;
}
function isTrue_(value) {return value===true||value===1||String(value).toLowerCase()==='true'||String(value).toUpperCase()==='YES'||String(value)==='1';}
function nowIso_() {return Utilities.formatDate(new Date(),APP.TIMEZONE,"yyyy-MM-dd'T'HH:mm:ssXXX");}
function today_() {return Utilities.formatDate(new Date(),APP.TIMEZONE,'yyyy-MM-dd');}
function normalizeDate_(value) {
  if(value===undefined||value===null||value==='')return '';
  if(value instanceof Date)return Utilities.formatDate(value,APP.TIMEZONE,'yyyy-MM-dd');
  var s=String(value).trim();if(/^\d{4}-\d{2}-\d{2}/.test(s))return s.slice(0,10);
  var d=new Date(s);if(isNaN(d.getTime()))throw apiError_('INVALID_DATE','รูปแบบวันที่ไม่ถูกต้อง');return Utilities.formatDate(d,APP.TIMEZONE,'yyyy-MM-dd');
}
function getThaiFiscalYear_(dateValue) {
  var y,m;
  if(dateValue){var s=normalizeDate_(dateValue);y=Number(s.slice(0,4));m=Number(s.slice(5,7));}
  else {var now=new Date();y=Number(Utilities.formatDate(now,APP.TIMEZONE,'yyyy'));m=Number(Utilities.formatDate(now,APP.TIMEZONE,'M'));}
  return m>=10?y+544:y+543;
}
function getFiscalYearForAgency_(dateValue,agency) {
  var s=normalizeDate_(dateValue)||today_(),year=Number(s.slice(0,4)),month=Number(s.slice(5,7)),start=Number(agency&&agency.fiscal_year_start_month)||10;
  return year+543+(start>1&&month>=start?1:0);
}
function monthKeyFromDate_(date) {return Utilities.formatDate(date,APP.TIMEZONE,'MM');}
function paginate_(rows,data,customMax) {
  var page=Math.max(1,Number(data&&data.page)||1),size=Math.max(1,Math.min(Number(data&&data.pageSize)||APP.DEFAULT_PAGE_SIZE,customMax||APP.MAX_PAGE_SIZE));
  var start=(page-1)*size;return rows.slice(start,start+size);
}
function countBy_(rows,key) {var out={};rows.forEach(function(r){var k=String(r[key]||'ไม่ระบุ');out[k]=(out[k]||0)+1;});return out;}
function formatBytes_(bytes) {if(bytes<1024)return bytes+' B';if(bytes<1048576)return (bytes/1024).toFixed(1)+' KB';return (bytes/1048576).toFixed(1)+' MB';}
function sanitizeFileName_(name) {return String(name||'file').replace(/[\\/:*?"<>|\x00-\x1F]/g,'_').replace(/\s+/g,' ').slice(0,160)||'file';}
function slug_(value) {return String(value||'x').toLowerCase().replace(/[^a-z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,48)||'x';}
function escapeHtml_(value) {return String(value||'').replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}


/* ========================================================================== */
/* 27. API CATALOG FOR index.html, dashboard.html AND THE GATEWAY              */
/* ========================================================================== */
/*
 * All business actions are POSTed as payload.action and payload.data through
 * the signed API Gateway. The Gateway injects payload.token from the active
 * session and signs the complete payload using GATEWAY_SHARED_SECRET.
 *
 * Public/pre-auth actions:
 *   health, public.agencyLookup, auth.login, auth.requestPasswordReset,
 *   auth.resetPassword
 *
 * Authentication/profile:
 *   auth.me, auth.logout, auth.changePassword, auth.updateProfile
 *
 * Agency/user administration:
 *   agencies.list/get/create/update/deactivate
 *   users.list/get/create/update/deactivate/resetPassword
 *   departments.list/create/update/deactivate
 *   roles.list/create/update/setPermissions, permissions.list
 *
 * Registry and workflow:
 *   books.incoming.list/get/create/update/delete
 *   books.outgoing.list/get/create/update/delete
 *   assignments.list/create/update, workflow.list/add, search.global
 *
 * Files and media:
 *   attachments.list/upload/download/delete, images.upload/list
 *   documentTypes.list/create/update, categories.list/create/update
 *
 * Reports/system:
 *   reports.summary, reports.globalSummary, reports.registryData,
 *   pdf.registryData, pdf.encryptAndStore, notifications.list/markRead,
 *   audit.list, downloads.list, settings.get/update,
 *   backup.create/list/restore, system.status
 *
 * Standard success response: {ok:true,code:"OK",data:...,requestId,timestamp}
 * Standard error response: {ok:false,code,message,requestId,timestamp}
 * File download responses contain fileBase64, fileName, mimeType and sizeBytes.
 * The frontend must decode fileBase64 to a Blob and trigger a browser download;
 * it must never open a Google Drive URL. Do not store session tokens in GitHub
 * source code or localStorage. Use a protected session strategy in the Gateway.
 */

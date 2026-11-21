/***************************************************************************************
 * DOCUMENT REGISTRY SYSTEM - Google Apps Script Backend
 * Files to add to the Apps Script project: Code.gs, index.html, dashboard.html
 *
 * Frontend API contract:
 *   google.script.run.withSuccessHandler(onOk).withFailureHandler(onFail)
 *     .apiCall('register.receive.list', {page:1,pageSize:25}, sessionToken);
 * Responses are {success:true,data:<value>} or {success:false,code,error}.
 *
 * Setup:
 *   1) Run setupSystem_() manually from the Apps Script editor once.
 *   2) Set BOOTSTRAP_TOKEN, IMGBB_API_KEY, ADOBE_PDF_SERVICES_CLIENT_ID and
 *      ADOBE_PDF_SERVICES_CLIENT_SECRET in Project Settings > Script Properties.
 *   3) Call system.bootstrap once with bootstrapToken, username, password and fullName.
 *   4) Add index.html and dashboard.html; deploy this Apps Script project as a Web App.
 *   5) Store this file and the two HTML files in the GitHub repository; use clasp to sync to Apps Script.
 *
 * Security / platform boundaries:
 *   - Sheets is the metadata database. Original files remain in a private Drive folder.
 *   - Downloads are returned as Base64 for the browser to convert into a Blob and save
 *     locally; no Drive URL is exposed. The frontend must immediately revoke Blob URLs.
 *   - PDF downloads are password-protected by Adobe PDF Services API using AES-256.
 *     Non-PDF downloads fail closed because Adobe Protect PDF does not encrypt Office,
 *     image, ZIP or other non-PDF file formats. Do not return an unencrypted file as protected.
 *   - Adobe credentials are stored only in Script Properties. Source PDFs are uploaded
 *     to Adobe for processing; do not use this service for restricted documents unless
 *     the organization has approved the external processing and data terms.
 *   - Transfers are limited by MAX_UPLOAD_BYTES / MAX_DOWNLOAD_BYTES (default 8 MiB).
 *     Larger files need a signed streaming/download service rather than Base64 RPC.
 *   - PasswordForClipboard is returned to the browser only after successful encryption.
 *     The UI must never render it, persist it, or write it to logs; only Clipboard.
 *   - Store all secrets in Script Properties, never in these source files or GitHub.
 ***************************************************************************************/
/* ========================================================================== */
/*  01. CONFIGURATION                                                         */
/* ========================================================================== */
const APP_CONFIG = Object.freeze({
    APP_NAME: 'ระบบทะเบียนรับ-ส่งหนังสือ', APP_VERSION: '1.0.0',
    DEFAULT_TIMEZONE: 'Asia/Bangkok', SYSTEM_DEPARTMENT_ID: 'SYSTEM',
    SYSTEM_DEPARTMENT_CODE: 'SYSTEM', SESSION_HOURS: 12,
    REMEMBER_SESSION_DAYS: 30, PASSWORD_MIN_LENGTH: 10,
    MAX_LOGIN_FAILURES: 8, LOGIN_LOCK_MINUTES: 15,
    DEFAULT_PAGE_SIZE: 25, MAX_PAGE_SIZE: 200,
    MAX_UPLOAD_BYTES: 8 * 1024 * 1024, MAX_DOWNLOAD_BYTES: 8 * 1024 * 1024,
    PASSWORD_DOWNLOAD_MASK: '••••••••••••••••••••',
    IMAGE_MIME_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    DOCUMENT_MIME_TYPES: [
        'application/pdf', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain', 'image/jpeg', 'image/png', 'image/webp', 'application/zip', 'application/x-zip-compressed'
    ]
});
const PROP = Object.freeze({
    DB_SPREADSHEET_ID: 'DB_SPREADSHEET_ID', DRIVE_ROOT_FOLDER_ID: 'DRIVE_ROOT_FOLDER_ID',
    BOOTSTRAP_TOKEN: 'BOOTSTRAP_TOKEN', PASSWORD_PEPPER: 'PASSWORD_PEPPER',
    SESSION_PEPPER: 'SESSION_PEPPER', IMGBB_API_KEY: 'IMGBB_API_KEY',
    ADOBE_PDF_SERVICES_CLIENT_ID: 'ADOBE_PDF_SERVICES_CLIENT_ID',
    ADOBE_PDF_SERVICES_CLIENT_SECRET: 'ADOBE_PDF_SERVICES_CLIENT_SECRET',
    APP_TIMEZONE: 'APP_TIMEZONE', MAX_UPLOAD_BYTES: 'MAX_UPLOAD_BYTES',
    MAX_DOWNLOAD_BYTES: 'MAX_DOWNLOAD_BYTES'
});
/* ========================================================================== */
/*  02. GOOGLE SHEETS SCHEMA - ALL TABLES / COLUMNS                           */
/* ========================================================================== */
// Schema repair only adds missing tabs/columns. It never deletes existing data.
const DB_SCHEMA = Object.freeze({
    Departments: [
        'DepartmentID', 'DepartmentCode', 'DepartmentName', 'ShortName', 'ParentDepartmentID',
        'Address', 'SubDistrict', 'District', 'Province', 'PostalCode', 'Phone', 'Email', 'Website',
        'LogoURL', 'LogoDeleteURL', 'DriveFolderID', 'AdminUserID', 'FiscalYearStartMonth',
        'ReceivePrefix', 'SendPrefix', 'RegisterNumberDigits', 'TimeZone', 'Status', 'Notes',
        'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy', 'DeletedAt', 'DeletedBy'
    ],
    Users: [
        'UserID', 'DepartmentID', 'Username', 'PasswordHash', 'PasswordSalt', 'FullName', 'FirstName',
        'LastName', 'Email', 'Phone', 'Position', 'Division', 'RoleCode', 'PermissionsJSON', 'AvatarURL',
        'Status', 'MustChangePassword', 'FailedLoginCount', 'LockedUntil', 'LastLoginAt', 'LastLoginIP',
        'PasswordChangedAt', 'RememberMeAllowed', 'LastPasswordResetAt', 'CreatedAt', 'CreatedBy',
        'UpdatedAt', 'UpdatedBy', 'DeletedAt', 'DeletedBy'
    ],
    Roles: ['RoleID', 'RoleCode', 'RoleName', 'Description', 'IsSystem', 'IsActive', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    Permissions: ['PermissionID', 'RoleCode', 'Module', 'Action', 'IsAllowed', 'Scope', 'Description', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'],
    ReceiveRegister: [
        'RecordID', 'DepartmentID', 'RegisterNo', 'RegisterYear', 'FiscalYear', 'ReceiveDate', 'ReceiveTime',
        'BookNo', 'BookDate', 'FromOrganization', 'FromDepartment', 'FromPerson', 'FromContact', 'Subject',
        'DocumentType', 'UrgencyLevel', 'ConfidentialityLevel', 'NumberOfPages', 'AttachmentCount',
        'ReceivedByUserID', 'ResponsibleUserID', 'ResponsibleDepartmentID', 'DueDate', 'Status', 'CompletionDate',
        'ReferenceSendRecordID', 'RelatedDocumentID', 'DistributionMethod', 'Keywords', 'SearchText', 'Notes',
        'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy', 'DeletedAt', 'DeletedBy'
    ],
    SendRegister: [
        'RecordID', 'DepartmentID', 'RegisterNo', 'RegisterYear', 'FiscalYear', 'SendDate', 'SendTime', 'BookNo',
        'BookDate', 'ToOrganization', 'ToDepartment', 'ToPerson', 'ToAddress', 'ToContact', 'Subject', 'DocumentType',
        'UrgencyLevel', 'ConfidentialityLevel', 'NumberOfPages', 'AttachmentCount', 'PreparedByUserID', 'ApprovedByUserID',
        'ResponsibleUserID', 'Status', 'DueDate', 'CompletionDate', 'DispatchMethod', 'TrackingNumber', 'DispatchDate', 'DeliveryDate',
        'RelatedReceiveRecordID', 'RelatedDocumentID', 'Keywords', 'SearchText', 'Notes', 'CreatedAt', 'CreatedBy',
        'UpdatedAt', 'UpdatedBy', 'DeletedAt', 'DeletedBy'
    ],
    Documents: [
        'DocumentID', 'DepartmentID', 'DocumentCode', 'Title', 'Subject', 'DocumentType', 'Direction', 'SourceRecordID',
        'SourceRecordType', 'BookNo', 'BookDate', 'FromOrganization', 'ToOrganization', 'OwnerUserID',
        'ResponsibleUserID', 'Status', 'ConfidentialityLevel', 'UrgencyLevel', 'MainAttachmentID', 'CurrentVersion',
        'Keywords', 'SearchText', 'Notes', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy', 'DeletedAt', 'DeletedBy'
    ],
    Attachments: [
        'AttachmentID', 'DepartmentID', 'DocumentID', 'RecordID', 'RecordType', 'AttachmentCategory', 'FileName',
        'OriginalFileName', 'FileExtension', 'MimeType', 'FileSizeBytes', 'DriveFileID', 'DriveFolderID',
        'StorageProvider', 'IsMainFile', 'IsPasswordProtectedSource', 'ChecksumSHA256', 'UploadedByUserID',
        'UploadedAt', 'Status', 'Notes', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy', 'DeletedAt', 'DeletedBy'
    ],
    Workflow: [
        'WorkflowID', 'DepartmentID', 'RecordID', 'RecordType', 'DocumentID', 'StepNo', 'ActionType', 'FromUserID',
        'ToUserID', 'FromDepartmentID', 'ToDepartmentID', 'ActionNote', 'Instruction', 'Status', 'SentAt',
        'ReceivedAt', 'CompletedAt', 'SignatureText', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'
    ],
    Assignments: [
        'AssignmentID', 'DepartmentID', 'RecordID', 'RecordType', 'DocumentID', 'TaskTitle', 'Description',
        'AssignedByUserID', 'AssignedToUserID', 'AssignedDepartmentID', 'DueDate', 'Priority', 'Status',
        'ProgressPercent', 'StartedAt', 'CompletedAt', 'ResultText', 'CreatedAt', 'CreatedBy', 'UpdatedAt',
        'UpdatedBy', 'DeletedAt', 'DeletedBy'
    ],
    Notifications: [
        'NotificationID', 'DepartmentID', 'UserID', 'Type', 'Title', 'Message', 'LinkType', 'LinkID',
        'IsRead', 'ReadAt', 'CreatedAt', 'CreatedBy', 'ExpiresAt'
    ],
    Categories: [
        'CategoryID', 'DepartmentID', 'CategoryType', 'CategoryCode', 'CategoryName', 'Description',
        'SortOrder', 'IsActive', 'IsSystem', 'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy'
    ],
    Settings: ['SettingID', 'DepartmentID', 'SettingKey', 'SettingValue', 'DataType', 'Description', 'IsPublic', 'UpdatedAt', 'UpdatedBy'],
    AuditLogs: [
        'AuditID', 'DepartmentID', 'UserID', 'Username', 'RoleCode', 'Action', 'Module', 'RecordID', 'RecordType',
        'Description', 'BeforeJSON', 'AfterJSON', 'Result', 'IPHint', 'UserAgentHint', 'CreatedAt'
    ],
    DownloadLogs: [
        'DownloadID', 'DepartmentID', 'UserID', 'AttachmentID', 'DocumentID', 'RecordID', 'RecordType', 'FileName',
        'MimeType', 'FileSizeBytes', 'PasswordProtected', 'PasswordReferenceID', 'DownloadStatus', 'CreatedAt'
    ],
    PasswordRecords: [
        'PasswordReferenceID', 'DepartmentID', 'UserID', 'DownloadID', 'PasswordFingerprint', 'Algorithm',
        'FileName', 'CreatedAt', 'ExpiresAt', 'Status', 'ConsumedAt'
    ],
    Trash: ['TrashID', 'DepartmentID', 'SourceSheet', 'SourceRecordID', 'RecordJSON', 'DeletedBy', 'DeletedAt', 'RestoreStatus', 'RestoredAt', 'RestoredBy', 'Reason'],
    Sessions: ['SessionID', 'SessionHash', 'UserID', 'DepartmentID', 'RoleCode', 'CreatedAt', 'LastSeenAt', 'ExpiresAt', 'RememberMe', 'Status', 'RevokedAt'],
    LoginAttempts: ['AttemptID', 'DepartmentCode', 'Username', 'AttemptedAt', 'WasSuccessful', 'LockUntil', 'Reason'],
    PasswordResetRequests: ['RequestID', 'DepartmentID', 'UserID', 'Username', 'RequestTokenHash', 'RequestedAt', 'ExpiresAt', 'Status', 'ProcessedBy', 'ProcessedAt'],
    ImageAssets: ['ImageID', 'DepartmentID', 'OwnerType', 'OwnerID', 'ImageCategory', 'OriginalFileName', 'MimeType', 'FileSizeBytes', 'ImageURL', 'DeleteURL', 'UploadedByUserID', 'UploadedAt', 'Status', 'Notes'],
    Backups: ['BackupID', 'BackupName', 'DriveFileID', 'CreatedAt', 'CreatedBy', 'FileSizeBytes', 'Status', 'Notes']
});
const DEFAULT_ROLES = Object.freeze([
    { code: 'SUPER_ADMIN', name: 'ผู้ดูแลระบบส่วนกลาง', description: 'จัดการระบบและทุกหน่วยงาน', system: true },
    { code: 'DEPT_ADMIN', name: 'ผู้ดูแลระบบหน่วยงาน', description: 'จัดการข้อมูลภายในหน่วยงาน', system: true },
    { code: 'REGISTRAR', name: 'เจ้าหน้าที่สารบรรณ', description: 'ลงทะเบียนรับ-ส่งและจัดการหนังสือ', system: true },
    { code: 'STAFF', name: 'เจ้าหน้าที่ทั่วไป', description: 'ดูและดำเนินการตามสิทธิ์ที่ได้รับ', system: true },
    { code: 'DEPT_HEAD', name: 'หัวหน้าฝ่าย', description: 'ตรวจสอบ ส่งต่อ และสั่งการ', system: true },
    { code: 'EXECUTIVE', name: 'ผู้บริหาร', description: 'พิจารณา อนุมัติ และสั่งการ', system: true },
    { code: 'AUDITOR', name: 'ผู้ตรวจสอบ', description: 'อ่านข้อมูลและตรวจสอบประวัติ', system: true }
]);
const DEFAULT_PERMISSION_MATRIX = Object.freeze({
    REGISTRAR: [
        'dashboard.view', 'receive.view', 'receive.create', 'receive.update', 'receive.delete',
        'send.view', 'send.create', 'send.update', 'send.delete', 'documents.view', 'documents.create',
        'documents.update', 'attachments.view', 'attachments.upload', 'attachments.download', 'attachments.delete',
        'images.upload', 'workflow.view', 'workflow.forward', 'workflow.acknowledge', 'assignments.view',
        'assignments.create', 'assignments.update', 'search.view', 'reports.view', 'reports.export',
        'notifications.view', 'settings.view', 'users.changePassword'
    ],
    STAFF: [
        'dashboard.view', 'receive.view', 'send.view', 'documents.view', 'attachments.view', 'attachments.download',
        'workflow.view', 'workflow.acknowledge', 'assignments.view', 'assignments.update', 'search.view',
        'notifications.view', 'users.changePassword'
    ],
    DEPT_HEAD: [
        'dashboard.view', 'receive.view', 'receive.update', 'send.view', 'send.update', 'documents.view',
        'documents.update', 'attachments.view', 'attachments.download', 'workflow.view', 'workflow.forward',
        'workflow.approve', 'workflow.reject', 'workflow.acknowledge', 'assignments.view', 'assignments.create',
        'assignments.update', 'search.view', 'reports.view', 'reports.export', 'notifications.view', 'users.changePassword'
    ],
    EXECUTIVE: [
        'dashboard.view', 'receive.view', 'send.view', 'documents.view', 'attachments.view', 'attachments.download',
        'workflow.view', 'workflow.approve', 'workflow.reject', 'workflow.forward', 'assignments.view',
        'reports.view', 'reports.export', 'search.view', 'notifications.view', 'users.changePassword'
    ],
    AUDITOR: ['dashboard.view', 'receive.view', 'send.view', 'documents.view', 'attachments.view', 'search.view', 'reports.view', 'audit.view', 'downloads.view', 'users.changePassword']
});
/* ========================================================================== */
/*  03. WEB ENTRY POINTS AND API ROUTER                                        */
/* ========================================================================== */
function doGet(e) {
    const params = e && e.parameter ? e.parameter : {};
    const page = String(params.page || '').toLowerCase() === 'dashboard' ? 'dashboard' : 'index';
    return HtmlService.createHtmlOutputFromFile(page)
        .setTitle(APP_CONFIG.APP_NAME)
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function doPost(e) {
    try {
        const body = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : '{}');
        const result = apiCall(String(body.action || ''), body.payload || {}, String(body.sessionToken || ''));
        return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
    }
    catch (error) {
        return ContentService.createTextOutput(JSON.stringify({ success: false, code: 'REQUEST_FAILED', error: safeErrorMessage_(error) }))
            .setMimeType(ContentService.MimeType.JSON);
    }
}
/** Main API called by index.html and dashboard.html. */
function apiCall(action, payload, sessionToken) {
    const actionName = String(action || '').trim();
    const input = payload && typeof payload === 'object' ? payload : {};
    try {
        ensureDatabaseReady_();
        // Unauthenticated routes: lookup/login/bootstrap only.
        if (actionName === 'system.publicConfig')
            return success_(getPublicConfig_());
        if (actionName === 'system.health')
            return success_(getHealthStatus_());
        if (actionName === 'auth.departmentLookup')
            return success_(lookupDepartmentPublic_(input.departmentCode));
        if (actionName === 'auth.login')
            return success_(login_(input));
        if (actionName === 'auth.requestPasswordReset')
            return success_(requestPasswordReset_(input));
        if (actionName === 'system.bootstrap')
            return success_(bootstrapSuperAdmin_(input));
        const context = requireSession_(sessionToken);
        context.sessionToken = String(sessionToken || '');
        if (isTrue_(context.user.MustChangePassword) && !['auth.me', 'auth.logout', 'users.changePassword'].includes(actionName))
            throw appError_('PASSWORD_CHANGE_REQUIRED', 'กรุณาเปลี่ยนรหัสผ่านก่อนเริ่มใช้งานระบบ');
        if (actionName === 'auth.me')
            return success_(getSafeSessionProfile_(context));
        if (actionName === 'auth.logout')
            return success_(logout_(context, sessionToken));
        const route = API_ROUTES[actionName];
        if (!route)
            throw appError_('UNKNOWN_ACTION', 'ไม่พบคำสั่ง API ที่ร้องขอ');
        requirePermission_(context, route.permission);
        return success_(route.handler(input, context));
    }
    catch (error) {
        return { success: false, code: error && error.code ? String(error.code) : 'API_ERROR', error: safeErrorMessage_(error) };
    }
}
const API_ROUTES = Object.freeze({
    'dashboard.summary': { permission: 'dashboard.view', handler: apiDashboardSummary_ },
    'departments.list': { permission: 'departments.view', handler: apiListDepartments_ },
    'departments.get': { permission: 'departments.view', handler: apiGetDepartment_ },
    'departments.create': { permission: 'departments.create', handler: apiCreateDepartment_ },
    'departments.update': { permission: 'departments.update', handler: apiUpdateDepartment_ },
    'departments.deactivate': { permission: 'departments.deactivate', handler: apiDeactivateDepartment_ },
    'users.list': { permission: 'users.view', handler: apiListUsers_ },
    'users.create': { permission: 'users.create', handler: apiCreateUser_ },
    'users.update': { permission: 'users.update', handler: apiUpdateUser_ },
    'users.deactivate': { permission: 'users.deactivate', handler: apiDeactivateUser_ },
    'users.resetPassword': { permission: 'users.resetPassword', handler: apiResetUserPassword_ },
    'users.changePassword': { permission: 'users.changePassword', handler: apiChangeOwnPassword_ },
    'roles.list': { permission: 'roles.view', handler: apiListRoles_ },
    'roles.save': { permission: 'roles.manage', handler: apiSaveRole_ },
    'permissions.list': { permission: 'permissions.view', handler: apiListPermissions_ },
    'permissions.save': { permission: 'permissions.manage', handler: apiSavePermissions_ },
    'register.receive.list': { permission: 'receive.view', handler: apiListReceive_ },
    'register.receive.get': { permission: 'receive.view', handler: apiGetReceive_ },
    'register.receive.create': { permission: 'receive.create', handler: apiCreateReceive_ },
    'register.receive.update': { permission: 'receive.update', handler: apiUpdateReceive_ },
    'register.receive.delete': { permission: 'receive.delete', handler: apiDeleteReceive_ },
    'register.send.list': { permission: 'send.view', handler: apiListSend_ },
    'register.send.get': { permission: 'send.view', handler: apiGetSend_ },
    'register.send.create': { permission: 'send.create', handler: apiCreateSend_ },
    'register.send.update': { permission: 'send.update', handler: apiUpdateSend_ },
    'register.send.delete': { permission: 'send.delete', handler: apiDeleteSend_ },
    'documents.list': { permission: 'documents.view', handler: apiListDocuments_ },
    'documents.get': { permission: 'documents.view', handler: apiGetDocument_ },
    'documents.create': { permission: 'documents.create', handler: apiCreateDocument_ },
    'documents.update': { permission: 'documents.update', handler: apiUpdateDocument_ },
    'documents.delete': { permission: 'documents.delete', handler: apiDeleteDocument_ },
    'attachments.list': { permission: 'attachments.view', handler: apiListAttachments_ },
    'attachments.upload': { permission: 'attachments.upload', handler: apiUploadAttachment_ },
    'attachments.download': { permission: 'attachments.download', handler: apiDownloadAttachment_ },
    'attachments.delete': { permission: 'attachments.delete', handler: apiDeleteAttachment_ },
    'pdf.storeGenerated': { permission: 'reports.export', handler: apiStoreGeneratedPdf_ },
    'images.upload': { permission: 'images.upload', handler: apiUploadImage_ },
    'workflow.list': { permission: 'workflow.view', handler: apiListWorkflow_ },
    'workflow.forward': { permission: 'workflow.forward', handler: apiWorkflowForward_ },
    'workflow.approve': { permission: 'workflow.approve', handler: apiWorkflowApprove_ },
    'workflow.reject': { permission: 'workflow.reject', handler: apiWorkflowReject_ },
    'workflow.acknowledge': { permission: 'workflow.acknowledge', handler: apiWorkflowAcknowledge_ },
    'assignments.list': { permission: 'assignments.view', handler: apiListAssignments_ },
    'assignments.create': { permission: 'assignments.create', handler: apiCreateAssignment_ },
    'assignments.update': { permission: 'assignments.update', handler: apiUpdateAssignment_ },
    'assignments.complete': { permission: 'assignments.update', handler: apiCompleteAssignment_ },
    'notifications.list': { permission: 'notifications.view', handler: apiListNotifications_ },
    'notifications.markRead': { permission: 'notifications.view', handler: apiMarkNotificationRead_ },
    'notifications.markAllRead': { permission: 'notifications.view', handler: apiMarkAllNotificationsRead_ },
    'search.all': { permission: 'search.view', handler: apiSearchAll_ },
    'reports.get': { permission: 'reports.view', handler: apiGetReport_ },
    'reports.exportLog': { permission: 'reports.export', handler: apiLogReportExport_ },
    'settings.list': { permission: 'settings.view', handler: apiListSettings_ },
    'settings.save': { permission: 'settings.manage', handler: apiSaveSettings_ },
    'categories.list': { permission: 'categories.view', handler: apiListCategories_ },
    'categories.create': { permission: 'categories.manage', handler: apiCreateCategory_ },
    'categories.update': { permission: 'categories.manage', handler: apiUpdateCategory_ },
    'categories.deactivate': { permission: 'categories.manage', handler: apiDeactivateCategory_ },
    'audit.list': { permission: 'audit.view', handler: apiListAuditLogs_ },
    'downloads.list': { permission: 'downloads.view', handler: apiListDownloadLogs_ },
    'passwordResetRequests.list': { permission: 'users.resetPassword', handler: apiListPasswordResetRequests_ },
    'passwordResetRequests.resolve': { permission: 'users.resetPassword', handler: apiResolvePasswordResetRequest_ },
    'trash.list': { permission: 'trash.view', handler: apiListTrash_ },
    'trash.restore': { permission: 'trash.restore', handler: apiRestoreTrash_ },
    'trash.permanentDelete': { permission: 'trash.permanentDelete', handler: apiPermanentDeleteTrash_ },
    'system.backups.list': { permission: 'system.backup', handler: apiListBackups_ },
    'system.backups.create': { permission: 'system.backup', handler: apiCreateBackup_ },
    'system.backups.restore': { permission: 'system.restore', handler: apiRestoreBackup_ },
    'system.maintenance': { permission: 'system.maintenance', handler: apiRunMaintenance_ }
});
/* ========================================================================== */
/*  04. INITIAL SETUP, SHEETS AND HEADER REPAIR                               */
/* ========================================================================== */
/** Run manually from the Apps Script editor once. Private from google.script.run. */
function setupSystem_() {
    const props = PropertiesService.getScriptProperties();
    let id = props.getProperty(PROP.DB_SPREADSHEET_ID);
    let db = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
    if (!db)
        db = SpreadsheetApp.create(APP_CONFIG.APP_NAME + ' - Database');
    props.setProperty(PROP.DB_SPREADSHEET_ID, db.getId());
    Object.keys(DB_SCHEMA).forEach(function (name) { ensureSheetSchema_(db, name, DB_SCHEMA[name]); });
    ensurePrivateDriveRoot_();
    ensureSecrets_();
    seedSystemDepartment_();
    seedRolesAndPermissions_();
    seedDefaultCategories_();
    seedDefaultSettings_();
    SpreadsheetApp.flush();
    return { success: true, message: 'เตรียมฐานข้อมูลและหัวตารางเรียบร้อยแล้ว', spreadsheetName: db.getName(), spreadsheetId: db.getId(), spreadsheetUrl: db.getUrl(), sheetCount: Object.keys(DB_SCHEMA).length, schemaVersion: APP_CONFIG.APP_VERSION };
}
function ensureDatabaseReady_() {
    if (!PropertiesService.getScriptProperties().getProperty(PROP.DB_SPREADSHEET_ID)) {
        throw appError_('DATABASE_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่าฐานข้อมูล กรุณาเรียก setupSystem_() จาก Apps Script Editor');
    }
}
function getDatabase_() {
    const id = PropertiesService.getScriptProperties().getProperty(PROP.DB_SPREADSHEET_ID);
    if (!id)
        throw appError_('DATABASE_NOT_CONFIGURED', 'ไม่พบรหัส Google Spreadsheet ฐานข้อมูล');
    try {
        return SpreadsheetApp.openById(id);
    }
    catch (error) {
        throw appError_('DATABASE_ACCESS_FAILED', 'ไม่สามารถเปิดฐานข้อมูล Google Sheets ได้');
    }
}
function ensureSheetSchema_(db, name, expected) {
    let sheet = db.getSheetByName(name);
    if (!sheet)
        sheet = db.insertSheet(name);
    const lastColumn = Math.max(sheet.getLastColumn(), 1);
    const headers = sheet.getLastRow() > 0 ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0].map(String) : [];
    if (!headers.some(function (v) { return v.trim() !== ''; })) {
        sheet.getRange(1, 1, 1, expected.length).setValues([expected]);
    }
    else {
        const missing = expected.filter(function (header) { return headers.indexOf(header) < 0; });
        if (missing.length)
            sheet.getRange(1, sheet.getLastColumn() + 1, 1, missing.length).setValues([missing]);
    }
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), expected.length)).setFontWeight('bold').setWrap(true);
    try {
        sheet.autoResizeColumns(1, Math.min(Math.max(sheet.getLastColumn(), expected.length), 20));
    }
    catch (ignore) { }
    return sheet;
}
function ensureAllSchemas_() {
    const db = getDatabase_();
    Object.keys(DB_SCHEMA).forEach(function (name) { ensureSheetSchema_(db, name, DB_SCHEMA[name]); });
}
function getSheet_(name) {
    const sheet = getDatabase_().getSheetByName(name);
    if (!sheet)
        throw appError_('SHEET_NOT_FOUND', 'ไม่พบตารางข้อมูล ' + name);
    return sheet;
}
function getHeaders_(sheet) {
    const n = sheet.getLastColumn();
    return n < 1 ? [] : sheet.getRange(1, 1, 1, n).getDisplayValues()[0].map(String);
}
function rowsToObjects_(sheet, options) {
    const opts = options || {};
    const last = sheet.getLastRow();
    if (last < 2)
        return [];
    const headers = getHeaders_(sheet);
    return sheet.getRange(2, 1, last - 1, headers.length).getValues().map(function (row, index) {
        const item = { _rowNumber: index + 2 };
        headers.forEach(function (header, col) { item[header] = normalizeCellValue_(row[col]); });
        return item;
    }).filter(function (row) { return opts.includeDeleted || !row.DeletedAt; });
}
function normalizeCellValue_(value) {
    return value instanceof Date ? Utilities.formatDate(value, getTimeZone_(), "yyyy-MM-dd'T'HH:mm:ss") : (value == null ? '' : value);
}
function appendObject_(sheetName, object) {
    const sheet = getSheet_(sheetName);
    const headers = getHeaders_(sheet);
    sheet.appendRow(headers.map(function (key) { return safeSheetValue_(object[key] == null ? '' : object[key]); }));
    return sheet.getLastRow();
}
function updateObjectById_(sheetName, idField, idValue, patch) {
    const sheet = getSheet_(sheetName);
    const found = rowsToObjects_(sheet, { includeDeleted: true }).find(function (row) { return String(row[idField]) === String(idValue); });
    if (!found)
        throw appError_('RECORD_NOT_FOUND', 'ไม่พบข้อมูลที่ต้องการแก้ไข');
    const headers = getHeaders_(sheet);
    const merged = Object.assign({}, found, patch || {});
    sheet.getRange(found._rowNumber, 1, 1, headers.length).setValues([headers.map(function (key) { return safeSheetValue_(merged[key] == null ? '' : merged[key]); })]);
    return stripInternalFields_(merged);
}
function findObjectById_(sheetName, idField, idValue, includeDeleted) {
    return rowsToObjects_(getSheet_(sheetName), { includeDeleted: Boolean(includeDeleted) }).find(function (row) { return String(row[idField]) === String(idValue); }) || null;
}
function findObjects_(sheetName, predicate, includeDeleted) {
    return rowsToObjects_(getSheet_(sheetName), { includeDeleted: Boolean(includeDeleted) }).filter(predicate || function () { return true; });
}
function stripInternalFields_(record) { const copy = Object.assign({}, record || {}); delete copy._rowNumber; return copy; }
function safeRecord_(record) {
    const copy = stripInternalFields_(record);
    ['PasswordHash', 'PasswordSalt', 'RequestTokenHash', 'SessionHash', 'PasswordFingerprint', 'DriveFileID', 'DriveFolderID', 'DeleteURL', 'LogoDeleteURL'].forEach(function (key) { delete copy[key]; });
    return copy;
}
/* ========================================================================== */
/*  05. SEED DATA                                                             */
/* ========================================================================== */
function seedSystemDepartment_() {
    const exists = findObjects_('Departments', function (r) { return r.DepartmentID === APP_CONFIG.SYSTEM_DEPARTMENT_ID; }, true)[0];
    if (exists)
        return;
    appendObject_('Departments', {
        DepartmentID: APP_CONFIG.SYSTEM_DEPARTMENT_ID, DepartmentCode: APP_CONFIG.SYSTEM_DEPARTMENT_CODE,
        DepartmentName: 'ผู้ดูแลระบบส่วนกลาง', ShortName: 'ส่วนกลาง', FiscalYearStartMonth: 10,
        ReceivePrefix: 'รับ', SendPrefix: 'ส่ง', RegisterNumberDigits: 4, TimeZone: getTimeZone_(),
        Status: 'ACTIVE', Notes: 'หน่วยงานระบบสำหรับบัญชี Super Admin', CreatedAt: nowIso_(), CreatedBy: 'SYSTEM'
    });
}
function seedRolesAndPermissions_() {
    const existingRoles = findObjects_('Roles', function () { return true; }, true);
    DEFAULT_ROLES.forEach(function (role) {
        if (!existingRoles.some(function (r) { return r.RoleCode === role.code; })) {
            appendObject_('Roles', { RoleID: newId_('ROLE'), RoleCode: role.code, RoleName: role.name, Description: role.description, IsSystem: 'TRUE', IsActive: 'TRUE', CreatedAt: nowIso_(), CreatedBy: 'SYSTEM' });
        }
    });
    const existing = findObjects_('Permissions', function () { return true; }, true);
    Object.keys(DEFAULT_PERMISSION_MATRIX).forEach(function (roleCode) {
        DEFAULT_PERMISSION_MATRIX[roleCode].forEach(function (code) {
            const parts = code.split('.');
            const moduleName = parts[0];
            const actionName = parts.slice(1).join('.');
            if (!existing.some(function (r) { return r.RoleCode === roleCode && r.Module === moduleName && r.Action === actionName; })) {
                appendObject_('Permissions', { PermissionID: newId_('PERM'), RoleCode: roleCode, Module: moduleName, Action: actionName, IsAllowed: 'TRUE', Scope: 'DEPARTMENT', Description: 'ค่าเริ่มต้นของระบบ', CreatedAt: nowIso_(), CreatedBy: 'SYSTEM' });
            }
        });
    });
}
function seedDefaultCategories_() {
    const defaults = [
        ['DOCUMENT_TYPE', 'GENERAL', 'หนังสือทั่วไป'], ['DOCUMENT_TYPE', 'INTERNAL', 'หนังสือภายใน'],
        ['DOCUMENT_TYPE', 'EXTERNAL', 'หนังสือภายนอก'], ['DOCUMENT_TYPE', 'MEMO', 'บันทึกข้อความ'],
        ['DOCUMENT_TYPE', 'ORDER', 'คำสั่ง'], ['DOCUMENT_TYPE', 'ANNOUNCEMENT', 'ประกาศ'],
        ['DOCUMENT_TYPE', 'REGULATION', 'ระเบียบ'], ['DOCUMENT_TYPE', 'CIRCULAR', 'หนังสือเวียน'],
        ['URGENCY', 'NORMAL', 'ปกติ'], ['URGENCY', 'URGENT', 'ด่วน'], ['URGENCY', 'VERY_URGENT', 'ด่วนมาก'],
        ['URGENCY', 'MOST_URGENT', 'ด่วนที่สุด'], ['CONFIDENTIALITY', 'NORMAL', 'ปกติ'],
        ['CONFIDENTIALITY', 'CONFIDENTIAL', 'ลับ'], ['CONFIDENTIALITY', 'HIGHLY_CONFIDENTIAL', 'ลับมาก'],
        ['RECEIVE_STATUS', 'PENDING', 'รอดำเนินการ'], ['RECEIVE_STATUS', 'IN_PROGRESS', 'กำลังดำเนินการ'],
        ['RECEIVE_STATUS', 'COMPLETED', 'เสร็จสิ้น'], ['SEND_STATUS', 'DRAFT', 'ฉบับร่าง'],
        ['SEND_STATUS', 'WAITING_APPROVAL', 'รออนุมัติ'], ['SEND_STATUS', 'APPROVED', 'อนุมัติแล้ว'],
        ['SEND_STATUS', 'DISPATCHED', 'ส่งออกแล้ว'], ['SEND_STATUS', 'COMPLETED', 'เสร็จสิ้น']
    ];
    const existing = findObjects_('Categories', function () { return true; }, true);
    defaults.forEach(function (x, index) {
        if (!existing.some(function (r) { return r.DepartmentID === APP_CONFIG.SYSTEM_DEPARTMENT_ID && r.CategoryType === x[0] && r.CategoryCode === x[1]; })) {
            appendObject_('Categories', { CategoryID: newId_('CAT'), DepartmentID: APP_CONFIG.SYSTEM_DEPARTMENT_ID, CategoryType: x[0], CategoryCode: x[1], CategoryName: x[2], SortOrder: index + 1, IsActive: 'TRUE', IsSystem: 'TRUE', CreatedAt: nowIso_(), CreatedBy: 'SYSTEM' });
        }
    });
}
function seedDefaultSettings_() {
    const defaults = [
        ['APP_NAME', APP_CONFIG.APP_NAME, 'STRING', 'ชื่อระบบ', true],
        ['FISCAL_YEAR_START_MONTH', '10', 'NUMBER', 'เดือนเริ่มต้นปีงบประมาณ', false],
        ['RECEIVE_PREFIX', 'รับ', 'STRING', 'คำนำหน้าเลขทะเบียนรับ', false],
        ['SEND_PREFIX', 'ส่ง', 'STRING', 'คำนำหน้าเลขทะเบียนส่ง', false],
        ['REGISTER_NUMBER_DIGITS', '4', 'NUMBER', 'จำนวนหลักเลขทะเบียน', false],
        ['DEFAULT_DUE_DAYS', '7', 'NUMBER', 'กำหนดวันดำเนินการเริ่มต้น', false],
        ['PASSWORD_DOWNLOAD_ENABLED', 'TRUE', 'BOOLEAN', 'เปิดการเข้ารหัสไฟล์เมื่อดาวน์โหลด', false],
        ['PDF_FONT_FAMILY', 'TH Sarabun New', 'STRING', 'ฟอนต์ PDF', false],
        ['PDF_PAPER_SIZE', 'A4', 'STRING', 'ขนาดกระดาษ PDF', false],
        ['PDF_ORIENTATION', 'LANDSCAPE', 'STRING', 'แนวกระดาษ PDF', false]
    ];
    const existing = findObjects_('Settings', function () { return true; }, true);
    defaults.forEach(function (x) {
        if (!existing.some(function (r) { return r.DepartmentID === APP_CONFIG.SYSTEM_DEPARTMENT_ID && r.SettingKey === x[0]; })) {
            appendObject_('Settings', { SettingID: newId_('SET'), DepartmentID: APP_CONFIG.SYSTEM_DEPARTMENT_ID, SettingKey: x[0], SettingValue: x[1], DataType: x[2], Description: x[3], IsPublic: x[4] ? 'TRUE' : 'FALSE', UpdatedAt: nowIso_(), UpdatedBy: 'SYSTEM' });
        }
    });
}
/* ========================================================================== */
/*  06. CRYPTOGRAPHY, IDS AND AUTHENTICATION                                  */
/* ========================================================================== */
function ensureSecrets_() {
    const p = PropertiesService.getScriptProperties();
    if (!p.getProperty(PROP.PASSWORD_PEPPER))
        p.setProperty(PROP.PASSWORD_PEPPER, randomSecret_());
    if (!p.getProperty(PROP.SESSION_PEPPER))
        p.setProperty(PROP.SESSION_PEPPER, randomSecret_());
}
function randomSecret_() { return [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid()].join('-'); }
function newId_(prefix) { return String(prefix || 'ID') + '-' + Utilities.getUuid().replace(/-/g, '').toUpperCase(); }
function hmacBase64_(value, secret) { return Utilities.base64Encode(Utilities.computeHmacSha256Signature(String(value), String(secret), Utilities.Charset.UTF_8)); }
function sha256Base64_(value) { return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value)); }
function passwordHash_(password, salt) {
    ensureSecrets_();
    return hmacBase64_(String(password) + '|' + String(salt), PropertiesService.getScriptProperties().getProperty(PROP.PASSWORD_PEPPER));
}
function verifyPassword_(password, salt, expected) { return constantTimeEquals_(passwordHash_(password, salt), String(expected || '')); }
function constantTimeEquals_(a, b) {
    const x = String(a || ''), y = String(b || ''), length = Math.max(x.length, y.length);
    let diff = x.length ^ y.length;
    for (let i = 0; i < length; i++)
        diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
    return diff === 0;
}
function hashSessionToken_(token) {
    ensureSecrets_();
    return hmacBase64_(String(token), PropertiesService.getScriptProperties().getProperty(PROP.SESSION_PEPPER));
}
function createRandomToken_() { return [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid()].join('.'); }
function generateFilePassword_() {
    const seed = [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(), nowIso_()].join('|');
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8);
    return Utilities.base64EncodeWebSafe(digest).replace(/=+$/g, '').substring(0, 32);
}
function filePasswordFingerprint_(password) {
    ensureSecrets_();
    return hmacBase64_(password, PropertiesService.getScriptProperties().getProperty(PROP.PASSWORD_PEPPER));
}
function validatePassword_(password) {
    const value = String(password || '');
    if (value.length < APP_CONFIG.PASSWORD_MIN_LENGTH)
        throw appError_('WEAK_PASSWORD', 'รหัสผ่านต้องมีอย่างน้อย ' + APP_CONFIG.PASSWORD_MIN_LENGTH + ' ตัวอักษร');
    if (value.length > 128)
        throw appError_('WEAK_PASSWORD', 'รหัสผ่านยาวเกินกำหนด');
}
function lookupDepartmentPublic_(departmentCode) {
    const code = normalizeCode_(departmentCode);
    if (!code)
        throw appError_('INVALID_DEPARTMENT_CODE', 'กรุณาระบุรหัสหน่วยงาน');
    const dept = findObjects_('Departments', function (r) { return normalizeCode_(r.DepartmentCode) === code && r.Status === 'ACTIVE' && !r.DeletedAt; })[0];
    if (!dept)
        throw appError_('DEPARTMENT_NOT_FOUND', 'ไม่พบรหัสหน่วยงาน หรือหน่วยงานถูกปิดใช้งาน');
    return { departmentId: dept.DepartmentID, departmentCode: dept.DepartmentCode, departmentName: dept.DepartmentName, shortName: dept.ShortName, logoURL: dept.LogoURL || '' };
}
function login_(input) {
    const code = normalizeCode_(input.departmentCode), username = String(input.username || '').trim(), password = String(input.password || ''), rememberRequested = isTrue_(input.rememberMe);
    if (!code || !username || !password)
        throw appError_('LOGIN_FIELDS_REQUIRED', 'กรุณากรอกรหัสหน่วยงาน ชื่อผู้ใช้ และรหัสผ่านให้ครบถ้วน');
    if (password.length > 256)
        throw appError_('INVALID_CREDENTIALS', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    const dept = findObjects_('Departments', function (r) { return normalizeCode_(r.DepartmentCode) === code && r.Status === 'ACTIVE' && !r.DeletedAt; })[0];
    if (!dept) {
        recordLoginAttempt_(code, username, false, 'DEPARTMENT_NOT_FOUND');
        throw appError_('INVALID_CREDENTIALS', 'รหัสหน่วยงาน ชื่อผู้ใช้ หรือรหัสผ่านไม่ถูกต้อง');
    }
    enforceLoginThrottle_(code, username);
    const user = findObjects_('Users', function (r) { return r.DepartmentID === dept.DepartmentID && String(r.Username).toLowerCase() === username.toLowerCase() && r.Status === 'ACTIVE' && !r.DeletedAt; })[0];
    if (!user || !verifyPassword_(password, user.PasswordSalt, user.PasswordHash)) {
        recordLoginAttempt_(code, username, false, 'INVALID_CREDENTIALS');
        if (user)
            incrementLoginFailure_(user);
        throw appError_('INVALID_CREDENTIALS', 'รหัสหน่วยงาน ชื่อผู้ใช้ หรือรหัสผ่านไม่ถูกต้อง');
    }
    if (user.LockedUntil && new Date(user.LockedUntil).getTime() > Date.now())
        throw appError_('ACCOUNT_LOCKED', 'บัญชีถูกระงับชั่วคราว กรุณาลองใหม่ภายหลัง');
    const remember = rememberRequested && isTrue_(user.RememberMeAllowed);
    const token = createRandomToken_(), timestamp = nowIso_();
    const expiry = remember ? new Date(Date.now() + APP_CONFIG.REMEMBER_SESSION_DAYS * 86400000) : new Date(Date.now() + APP_CONFIG.SESSION_HOURS * 3600000);
    appendObject_('Sessions', { SessionID: newId_('SES'), SessionHash: hashSessionToken_(token), UserID: user.UserID, DepartmentID: user.DepartmentID, RoleCode: user.RoleCode, CreatedAt: timestamp, LastSeenAt: timestamp, ExpiresAt: expiry.toISOString(), RememberMe: remember ? 'TRUE' : 'FALSE', Status: 'ACTIVE' });
    updateObjectById_('Users', 'UserID', user.UserID, { FailedLoginCount: 0, LockedUntil: '', LastLoginAt: timestamp, UpdatedAt: timestamp, UpdatedBy: user.UserID });
    recordLoginAttempt_(code, username, true, 'SUCCESS');
    logAudit_({ departmentId: user.DepartmentID, userId: user.UserID, username: user.Username, roleCode: user.RoleCode, action: 'LOGIN', module: 'auth', description: 'เข้าสู่ระบบสำเร็จ' });
    return {
        sessionToken: token, expiresAt: expiry.toISOString(), mustChangePassword: isTrue_(user.MustChangePassword),
        user: safeUserProfile_(user),
        department: { departmentId: dept.DepartmentID, departmentCode: dept.DepartmentCode, departmentName: dept.DepartmentName, shortName: dept.ShortName, logoURL: dept.LogoURL || '' },
        permissions: getUserPermissionCodes_(user.RoleCode, user.PermissionsJSON)
    };
}
function bootstrapSuperAdmin_(input) {
    const props = PropertiesService.getScriptProperties(), configured = props.getProperty(PROP.BOOTSTRAP_TOKEN), supplied = String(input.bootstrapToken || '');
    if (!configured)
        throw appError_('BOOTSTRAP_NOT_CONFIGURED', 'ผู้ดูแลระบบต้องตั้งค่า BOOTSTRAP_TOKEN ใน Script Properties ก่อน');
    if (!constantTimeEquals_(configured, supplied))
        throw appError_('BOOTSTRAP_TOKEN_INVALID', 'รหัสตั้งค่าเริ่มต้นไม่ถูกต้อง');
    if (findObjects_('Users', function (u) { return u.RoleCode === 'SUPER_ADMIN' && u.Status === 'ACTIVE' && !u.DeletedAt; })[0])
        throw appError_('SUPER_ADMIN_EXISTS', 'ระบบมีบัญชีผู้ดูแลระบบส่วนกลางแล้ว');
    const username = String(input.username || '').trim(), password = String(input.password || ''), fullName = String(input.fullName || '').trim();
    if (!/^[A-Za-z0-9._-]{4,50}$/.test(username))
        throw appError_('INVALID_USERNAME', 'ชื่อผู้ใช้ต้องมี 4-50 ตัวอักษร และใช้ A-Z, a-z, 0-9, จุด ขีด หรือขีดล่าง');
    validatePassword_(password);
    if (!fullName)
        throw appError_('FULL_NAME_REQUIRED', 'กรุณาระบุชื่อผู้ดูแลระบบ');
    const salt = createRandomToken_(), user = {
        UserID: newId_('USR'), DepartmentID: APP_CONFIG.SYSTEM_DEPARTMENT_ID, Username: username,
        PasswordHash: passwordHash_(password, salt), PasswordSalt: salt, FullName: fullName,
        Email: String(input.email || ''), RoleCode: 'SUPER_ADMIN', Status: 'ACTIVE', MustChangePassword: 'FALSE',
        FailedLoginCount: 0, RememberMeAllowed: 'TRUE', PasswordChangedAt: nowIso_(), CreatedAt: nowIso_(), CreatedBy: 'BOOTSTRAP'
    };
    appendObject_('Users', user);
    props.deleteProperty(PROP.BOOTSTRAP_TOKEN);
    logAudit_({ departmentId: APP_CONFIG.SYSTEM_DEPARTMENT_ID, userId: user.UserID, username: user.Username, roleCode: 'SUPER_ADMIN', action: 'BOOTSTRAP_SUPER_ADMIN', module: 'system', description: 'สร้างบัญชี Super Admin เริ่มต้น' });
    return { created: true, message: 'สร้างบัญชีผู้ดูแลระบบส่วนกลางเรียบร้อยแล้ว' };
}
function requestPasswordReset_(input) {
    const code = normalizeCode_(input.departmentCode), username = String(input.username || '').trim();
    if (!code || !username)
        throw appError_('RESET_FIELDS_REQUIRED', 'กรุณาระบุรหัสหน่วยงานและชื่อผู้ใช้');
    const dept = findObjects_('Departments', function (r) { return normalizeCode_(r.DepartmentCode) === code && r.Status === 'ACTIVE'; })[0];
    if (dept) {
        const user = findObjects_('Users', function (r) { return r.DepartmentID === dept.DepartmentID && String(r.Username).toLowerCase() === username.toLowerCase() && r.Status === 'ACTIVE'; })[0];
        if (user) {
            const pending = findObjects_('PasswordResetRequests', function (r) { return r.UserID === user.UserID && r.Status === 'PENDING' && new Date(r.ExpiresAt).getTime() > Date.now(); }, true)[0];
            if (!pending)
                appendObject_('PasswordResetRequests', { RequestID: newId_('PRQ'), DepartmentID: user.DepartmentID, UserID: user.UserID, Username: user.Username, RequestTokenHash: '', RequestedAt: nowIso_(), ExpiresAt: new Date(Date.now() + 86400000).toISOString(), Status: 'PENDING' });
        }
    }
    return { received: true, message: 'หากพบบัญชีที่ตรงกัน ผู้ดูแลระบบจะดำเนินการตรวจสอบ' };
}
function requireSession_(token) {
    const value = String(token || '').trim();
    if (!value)
        throw appError_('AUTH_REQUIRED', 'กรุณาเข้าสู่ระบบก่อนใช้งาน');
    const hash = hashSessionToken_(value), session = findObjects_('Sessions', function (r) { return r.SessionHash === hash && r.Status === 'ACTIVE'; }, true)[0];
    if (!session)
        throw appError_('SESSION_INVALID', 'เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบอีกครั้ง');
    if (!session.ExpiresAt || new Date(session.ExpiresAt).getTime() <= Date.now()) {
        updateObjectById_('Sessions', 'SessionID', session.SessionID, { Status: 'EXPIRED' });
        throw appError_('SESSION_EXPIRED', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');
    }
    const user = findObjectById_('Users', 'UserID', session.UserID, false);
    if (!user || user.Status !== 'ACTIVE')
        throw appError_('USER_INACTIVE', 'บัญชีผู้ใช้งานถูกปิดใช้งาน');
    const dept = findObjectById_('Departments', 'DepartmentID', user.DepartmentID, false);
    if (!dept || dept.Status !== 'ACTIVE')
        throw appError_('DEPARTMENT_INACTIVE', 'หน่วยงานถูกปิดใช้งาน');
    if (!session.LastSeenAt || Date.now() - new Date(session.LastSeenAt).getTime() > 300000)
        updateObjectById_('Sessions', 'SessionID', session.SessionID, { LastSeenAt: nowIso_() });
    return { session: session, user: user, department: dept, departmentId: user.DepartmentID, userId: user.UserID, roleCode: user.RoleCode, username: user.Username };
}
function logout_(context, token) {
    const hash = hashSessionToken_(token), session = findObjects_('Sessions', function (r) { return r.SessionHash === hash && r.Status === 'ACTIVE'; }, true)[0];
    if (session)
        updateObjectById_('Sessions', 'SessionID', session.SessionID, { Status: 'REVOKED', RevokedAt: nowIso_() });
    logAudit_({ departmentId: context.departmentId, userId: context.userId, username: context.username, roleCode: context.roleCode, action: 'LOGOUT', module: 'auth', description: 'ออกจากระบบ' });
    return { loggedOut: true };
}
function getSafeSessionProfile_(context) {
    return { user: safeUserProfile_(context.user), department: { departmentId: context.department.DepartmentID, departmentCode: context.department.DepartmentCode, departmentName: context.department.DepartmentName, shortName: context.department.ShortName, logoURL: context.department.LogoURL || '' }, permissions: getUserPermissionCodes_(context.roleCode, context.user.PermissionsJSON) };
}
function safeUserProfile_(u) {
    return { userId: u.UserID, departmentId: u.DepartmentID, username: u.Username, fullName: u.FullName, firstName: u.FirstName, lastName: u.LastName, email: u.Email, phone: u.Phone, position: u.Position, division: u.Division, roleCode: u.RoleCode, avatarURL: u.AvatarURL, status: u.Status, mustChangePassword: isTrue_(u.MustChangePassword) };
}
function enforceLoginThrottle_(code, username) {
    const cutoff = Date.now() - APP_CONFIG.LOGIN_LOCK_MINUTES * 60000;
    const failed = findObjects_('LoginAttempts', function (r) { return normalizeCode_(r.DepartmentCode) === code && String(r.Username).toLowerCase() === username.toLowerCase() && !isTrue_(r.WasSuccessful) && new Date(r.AttemptedAt).getTime() >= cutoff; }, true);
    if (failed.length >= APP_CONFIG.MAX_LOGIN_FAILURES)
        throw appError_('LOGIN_THROTTLED', 'เข้าสู่ระบบไม่สำเร็จหลายครั้ง กรุณารอ ' + APP_CONFIG.LOGIN_LOCK_MINUTES + ' นาทีแล้วลองใหม่');
}
function recordLoginAttempt_(code, username, success, reason) {
    appendObject_('LoginAttempts', { AttemptID: newId_('LAT'), DepartmentCode: code, Username: username, AttemptedAt: nowIso_(), WasSuccessful: success ? 'TRUE' : 'FALSE', Reason: reason || '' });
}
function incrementLoginFailure_(user) {
    const count = Number(user.FailedLoginCount || 0) + 1, patch = { FailedLoginCount: count, UpdatedAt: nowIso_(), UpdatedBy: 'SYSTEM' };
    if (count >= APP_CONFIG.MAX_LOGIN_FAILURES)
        patch.LockedUntil = new Date(Date.now() + APP_CONFIG.LOGIN_LOCK_MINUTES * 60000).toISOString();
    updateObjectById_('Users', 'UserID', user.UserID, patch);
}
function requirePermission_(ctx, permission) {
    if (!permission || ctx.roleCode === 'SUPER_ADMIN')
        return true;
    const parts = String(permission).split('.'), moduleName = parts[0], actionName = parts.slice(1).join('.');
    const overrides = parseJsonSafe_(ctx.user.PermissionsJSON, {});
    if (Object.prototype.hasOwnProperty.call(overrides, permission)) {
        if (overrides[permission] === true)
            return true;
        throw appError_('PERMISSION_DENIED', 'คุณไม่มีสิทธิ์ดำเนินการนี้');
    }
    if (ctx.roleCode === 'DEPT_ADMIN')
        return true;
    const rows = findObjects_('Permissions', function (r) { return r.RoleCode === ctx.roleCode && r.Module === moduleName && r.Action === actionName; });
    if (rows.some(function (r) { return isTrue_(r.IsAllowed); }))
        return true;
    throw appError_('PERMISSION_DENIED', 'คุณไม่มีสิทธิ์ดำเนินการนี้');
}
function getUserPermissionCodes_(roleCode, json) {
    if (roleCode === 'SUPER_ADMIN' || roleCode === 'DEPT_ADMIN')
        return ['*'];
    const codes = findObjects_('Permissions', function (r) { return r.RoleCode === roleCode && isTrue_(r.IsAllowed); }).map(function (r) { return r.Module + '.' + r.Action; });
    const overrides = parseJsonSafe_(json, {});
    Object.keys(overrides).forEach(function (code) {
        if (overrides[code] === true && codes.indexOf(code) < 0)
            codes.push(code);
        if (overrides[code] === false) {
            const index = codes.indexOf(code);
            if (index >= 0)
                codes.splice(index, 1);
        }
    });
    return codes;
}
/* ========================================================================== */
/*  07. DEPARTMENT MANAGEMENT                                                 */
/* ========================================================================== */
function apiListDepartments_(input, ctx) {
    const rows = findObjects_('Departments', function (r) {
        if (ctx.roleCode !== 'SUPER_ADMIN' && r.DepartmentID !== ctx.departmentId)
            return false;
        if (input.status && r.Status !== input.status)
            return false;
        return true;
    }, isTrue_(input.includeDeleted));
    return paginate_(rows.map(safeRecord_), input);
}
function apiGetDepartment_(input, ctx) {
    const id = String(input.departmentId || ctx.departmentId), dept = findObjectById_('Departments', 'DepartmentID', id, false);
    if (!dept)
        throw appError_('DEPARTMENT_NOT_FOUND', 'ไม่พบหน่วยงาน');
    assertDepartmentAccess_(ctx, dept.DepartmentID);
    return safeRecord_(dept);
}
function apiCreateDepartment_(input, ctx) {
    if (ctx.roleCode !== 'SUPER_ADMIN')
        throw appError_('PERMISSION_DENIED', 'เฉพาะ Super Admin เท่านั้นที่เพิ่มหน่วยงานได้');
    const code = normalizeCode_(input.departmentCode), name = String(input.departmentName || '').trim();
    if (!/^[A-Z0-9_-]{2,30}$/.test(code))
        throw appError_('INVALID_DEPARTMENT_CODE', 'รหัสหน่วยงานต้องเป็น A-Z, 0-9, _ หรือ - จำนวน 2-30 ตัว');
    if (!name)
        throw appError_('DEPARTMENT_NAME_REQUIRED', 'กรุณาระบุชื่อหน่วยงาน');
    if (findObjects_('Departments', function (r) { return normalizeCode_(r.DepartmentCode) === code; }, true)[0])
        throw appError_('DEPARTMENT_CODE_EXISTS', 'รหัสหน่วยงานนี้ถูกใช้แล้ว');
    const id = newId_('DEP'), dept = {
        DepartmentID: id, DepartmentCode: code, DepartmentName: name, ShortName: String(input.shortName || '').trim(),
        ParentDepartmentID: String(input.parentDepartmentId || ''), Address: String(input.address || ''),
        SubDistrict: String(input.subDistrict || ''), District: String(input.district || ''), Province: String(input.province || ''),
        PostalCode: String(input.postalCode || ''), Phone: String(input.phone || ''), Email: String(input.email || ''),
        Website: String(input.website || ''), LogoURL: String(input.logoURL || ''), LogoDeleteURL: String(input.logoDeleteURL || ''),
        FiscalYearStartMonth: clampNumber_(input.fiscalYearStartMonth, 1, 12, 10), ReceivePrefix: String(input.receivePrefix || 'รับ'),
        SendPrefix: String(input.sendPrefix || 'ส่ง'), RegisterNumberDigits: clampNumber_(input.registerNumberDigits, 2, 8, 4),
        TimeZone: String(input.timeZone || getTimeZone_()), Status: 'ACTIVE', Notes: String(input.notes || ''),
        CreatedAt: nowIso_(), CreatedBy: ctx.userId
    };
    appendObject_('Departments', dept);
    const folders = ensureDepartmentFolders_(id, code);
    const updated = updateObjectById_('Departments', 'DepartmentID', id, { DriveFolderID: folders.departmentFolderId, UpdatedAt: nowIso_(), UpdatedBy: ctx.userId });
    logAudit_({ departmentId: id, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'CREATE', module: 'departments', recordId: id, description: 'เพิ่มหน่วยงาน ' + name });
    return safeRecord_(updated);
}
function apiUpdateDepartment_(input, ctx) {
    const id = String(input.departmentId || '');
    if (!id)
        throw appError_('DEPARTMENT_ID_REQUIRED', 'ไม่พบรหัสหน่วยงาน');
    assertDepartmentAccess_(ctx, id);
    const current = findObjectById_('Departments', 'DepartmentID', id, false);
    if (!current)
        throw appError_('DEPARTMENT_NOT_FOUND', 'ไม่พบหน่วยงาน');
    if (ctx.roleCode !== 'SUPER_ADMIN' && ctx.roleCode !== 'DEPT_ADMIN')
        throw appError_('PERMISSION_DENIED', 'ไม่มีสิทธิ์แก้ไขหน่วยงาน');
    const map = { departmentName: 'DepartmentName', shortName: 'ShortName', parentDepartmentId: 'ParentDepartmentID', address: 'Address', subDistrict: 'SubDistrict', district: 'District', province: 'Province', postalCode: 'PostalCode', phone: 'Phone', email: 'Email', website: 'Website', logoURL: 'LogoURL', logoDeleteURL: 'LogoDeleteURL', fiscalYearStartMonth: 'FiscalYearStartMonth', receivePrefix: 'ReceivePrefix', sendPrefix: 'SendPrefix', registerNumberDigits: 'RegisterNumberDigits', timeZone: 'TimeZone', notes: 'Notes' };
    const patch = {};
    Object.keys(map).forEach(function (key) { if (input[key] !== undefined)
        patch[map[key]] = input[key]; });
    if (patch.DepartmentName !== undefined)
        patch.DepartmentName = String(patch.DepartmentName).trim();
    if (patch.FiscalYearStartMonth !== undefined)
        patch.FiscalYearStartMonth = clampNumber_(patch.FiscalYearStartMonth, 1, 12, 10);
    if (patch.RegisterNumberDigits !== undefined)
        patch.RegisterNumberDigits = clampNumber_(patch.RegisterNumberDigits, 2, 8, 4);
    if (ctx.roleCode !== 'SUPER_ADMIN') {
        delete patch.ReceivePrefix;
        delete patch.SendPrefix;
        delete patch.RegisterNumberDigits;
    }
    patch.UpdatedAt = nowIso_();
    patch.UpdatedBy = ctx.userId;
    const updated = updateObjectById_('Departments', 'DepartmentID', id, patch);
    logAudit_({ departmentId: id, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'UPDATE', module: 'departments', recordId: id, description: 'แก้ไขข้อมูลหน่วยงาน' });
    return safeRecord_(updated);
}
function apiDeactivateDepartment_(input, ctx) {
    if (ctx.roleCode !== 'SUPER_ADMIN')
        throw appError_('PERMISSION_DENIED', 'เฉพาะ Super Admin เท่านั้น');
    const id = String(input.departmentId || '');
    if (!id || id === APP_CONFIG.SYSTEM_DEPARTMENT_ID)
        throw appError_('INVALID_DEPARTMENT', 'ไม่สามารถปิดหน่วยงานระบบได้');
    const dept = findObjectById_('Departments', 'DepartmentID', id, false);
    if (!dept)
        throw appError_('DEPARTMENT_NOT_FOUND', 'ไม่พบหน่วยงาน');
    const status = input.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
    const updated = updateObjectById_('Departments', 'DepartmentID', id, { Status: status, UpdatedAt: nowIso_(), UpdatedBy: ctx.userId });
    if (status !== 'ACTIVE')
        revokeDepartmentSessions_(id);
    logAudit_({ departmentId: id, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'SET_STATUS', module: 'departments', recordId: id, description: 'เปลี่ยนสถานะหน่วยงานเป็น ' + status });
    return safeRecord_(updated);
}
/* ========================================================================== */
/*  08. USERS, ROLES, PERMISSIONS AND PASSWORD RESET                          */
/* ========================================================================== */
function apiListUsers_(input, ctx) {
    const rows = findObjects_('Users', function (r) {
        if (ctx.roleCode !== 'SUPER_ADMIN' && r.DepartmentID !== ctx.departmentId)
            return false;
        if (input.departmentId && ctx.roleCode === 'SUPER_ADMIN' && r.DepartmentID !== String(input.departmentId))
            return false;
        if (input.roleCode && r.RoleCode !== String(input.roleCode))
            return false;
        if (input.status && r.Status !== String(input.status))
            return false;
        return true;
    }, isTrue_(input.includeDeleted));
    return paginate_(rows.map(safeUserProfile_), input);
}
function apiCreateUser_(input, ctx) {
    const deptId = ctx.roleCode === 'SUPER_ADMIN' ? String(input.departmentId || '') : ctx.departmentId;
    const dept = findObjectById_('Departments', 'DepartmentID', deptId, false);
    if (!dept || dept.Status !== 'ACTIVE')
        throw appError_('DEPARTMENT_NOT_FOUND', 'ไม่พบหน่วยงานที่ใช้งานได้');
    const username = String(input.username || '').trim(), password = String(input.password || ''), fullName = String(input.fullName || '').trim(), role = String(input.roleCode || 'STAFF').toUpperCase();
    if (!/^[A-Za-z0-9._-]{4,50}$/.test(username))
        throw appError_('INVALID_USERNAME', 'ชื่อผู้ใช้ต้องมี 4-50 ตัวอักษร');
    if (!fullName)
        throw appError_('FULL_NAME_REQUIRED', 'กรุณาระบุชื่อ-นามสกุล');
    validatePassword_(password);
    assertRoleAssignmentAllowed_(ctx, role);
    if (role === 'SUPER_ADMIN' && deptId !== APP_CONFIG.SYSTEM_DEPARTMENT_ID)
        throw appError_('SUPER_ADMIN_SYSTEM_ONLY', 'บัญชี Super Admin ต้องอยู่ในหน่วยงาน SYSTEM เท่านั้น');
    if (!findObjects_('Roles', function (r) { return r.RoleCode === role && isTrue_(r.IsActive); })[0])
        throw appError_('ROLE_NOT_FOUND', 'ไม่พบบทบาทผู้ใช้งานนี้');
    if (findObjects_('Users', function (r) { return r.DepartmentID === deptId && String(r.Username).toLowerCase() === username.toLowerCase(); }, true)[0])
        throw appError_('USERNAME_EXISTS', 'ชื่อผู้ใช้นี้มีอยู่ในหน่วยงานแล้ว');
    const salt = createRandomToken_(), user = {
        UserID: newId_('USR'), DepartmentID: deptId, Username: username, PasswordHash: passwordHash_(password, salt), PasswordSalt: salt,
        FullName: fullName, FirstName: String(input.firstName || ''), LastName: String(input.lastName || ''), Email: String(input.email || ''),
        Phone: String(input.phone || ''), Position: String(input.position || ''), Division: String(input.division || ''), RoleCode: role,
        PermissionsJSON: JSON.stringify(input.permissions || {}), AvatarURL: String(input.avatarURL || ''), Status: 'ACTIVE',
        MustChangePassword: input.mustChangePassword === false ? 'FALSE' : 'TRUE', FailedLoginCount: 0,
        RememberMeAllowed: input.rememberMeAllowed === false ? 'FALSE' : 'TRUE', PasswordChangedAt: nowIso_(), CreatedAt: nowIso_(), CreatedBy: ctx.userId
    };
    appendObject_('Users', user);
    createNotification_({ departmentId: deptId, userId: user.UserID, type: 'ACCOUNT_CREATED', title: 'สร้างบัญชีผู้ใช้งาน', message: 'บัญชีของคุณถูกสร้างแล้ว กรุณาเข้าสู่ระบบและเปลี่ยนรหัสผ่าน', createdBy: ctx.userId });
    logAudit_({ departmentId: deptId, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'CREATE', module: 'users', recordId: user.UserID, description: 'เพิ่มผู้ใช้งาน ' + username });
    return safeUserProfile_(user);
}
function apiUpdateUser_(input, ctx) {
    const id = String(input.userId || ''), target = findObjectById_('Users', 'UserID', id, false);
    if (!target)
        throw appError_('USER_NOT_FOUND', 'ไม่พบผู้ใช้งาน');
    assertDepartmentAccess_(ctx, target.DepartmentID);
    const map = { fullName: 'FullName', firstName: 'FirstName', lastName: 'LastName', email: 'Email', phone: 'Phone', position: 'Position', division: 'Division', avatarURL: 'AvatarURL' }, patch = {};
    Object.keys(map).forEach(function (key) { if (input[key] !== undefined)
        patch[map[key]] = String(input[key] || ''); });
    if (input.status !== undefined) {
        if (target.UserID === ctx.userId && input.status !== 'ACTIVE')
            throw appError_('CANNOT_DISABLE_SELF', 'ไม่สามารถปิดบัญชีของตนเองได้');
        patch.Status = input.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
    }
    if (input.roleCode !== undefined) {
        const nextRole = String(input.roleCode).toUpperCase();
        assertRoleAssignmentAllowed_(ctx, nextRole);
        if (!findObjects_('Roles', function (r) { return r.RoleCode === nextRole && isTrue_(r.IsActive); })[0])
            throw appError_('ROLE_NOT_FOUND', 'ไม่พบบทบาทที่ต้องการกำหนด');
        if (nextRole === 'SUPER_ADMIN' && target.DepartmentID !== APP_CONFIG.SYSTEM_DEPARTMENT_ID)
            throw appError_('SUPER_ADMIN_SYSTEM_ONLY', 'บัญชี Super Admin ต้องอยู่ในหน่วยงาน SYSTEM เท่านั้น');
        if (target.UserID === ctx.userId && nextRole !== ctx.roleCode)
            throw appError_('CANNOT_CHANGE_SELF_ROLE', 'ไม่สามารถเปลี่ยนบทบาทของบัญชีตนเองได้');
        if (target.RoleCode === 'SUPER_ADMIN' && nextRole !== 'SUPER_ADMIN' && ctx.roleCode !== 'SUPER_ADMIN')
            throw appError_('ROLE_CHANGE_DENIED', 'ไม่มีสิทธิ์เปลี่ยนบทบาท Super Admin');
        patch.RoleCode = nextRole;
    }
    if (input.permissions !== undefined)
        patch.PermissionsJSON = JSON.stringify(input.permissions || {});
    patch.UpdatedAt = nowIso_();
    patch.UpdatedBy = ctx.userId;
    const updated = updateObjectById_('Users', 'UserID', id, patch);
    if (patch.Status === 'INACTIVE' || patch.RoleCode)
        revokeUserSessions_(id);
    logAudit_({ departmentId: target.DepartmentID, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'UPDATE', module: 'users', recordId: id, description: 'แก้ไขข้อมูลผู้ใช้งาน' });
    return safeUserProfile_(updated);
}
function apiDeactivateUser_(input, ctx) { return apiUpdateUser_(Object.assign({}, input, { status: input.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE' }), ctx); }
function apiResetUserPassword_(input, ctx) {
    const id = String(input.userId || ''), target = findObjectById_('Users', 'UserID', id, false);
    if (!target)
        throw appError_('USER_NOT_FOUND', 'ไม่พบผู้ใช้งาน');
    assertDepartmentAccess_(ctx, target.DepartmentID);
    if (ctx.roleCode !== 'SUPER_ADMIN' && ctx.roleCode !== 'DEPT_ADMIN')
        throw appError_('PERMISSION_DENIED', 'ไม่มีสิทธิ์รีเซ็ตรหัสผ่าน');
    const temp = String(input.temporaryPassword || '');
    validatePassword_(temp);
    const salt = createRandomToken_();
    updateObjectById_('Users', 'UserID', id, { PasswordHash: passwordHash_(temp, salt), PasswordSalt: salt, MustChangePassword: 'TRUE', FailedLoginCount: 0, LockedUntil: '', PasswordChangedAt: nowIso_(), LastPasswordResetAt: nowIso_(), UpdatedAt: nowIso_(), UpdatedBy: ctx.userId });
    revokeUserSessions_(id);
    logAudit_({ departmentId: target.DepartmentID, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'RESET_PASSWORD', module: 'users', recordId: id, description: 'รีเซ็ตรหัสผ่านผู้ใช้งาน' });
    return { reset: true, mustChangePassword: true };
}
function apiChangeOwnPassword_(input, ctx) {
    const current = String(input.currentPassword || ''), next = String(input.newPassword || '');
    validatePassword_(next);
    if (!verifyPassword_(current, ctx.user.PasswordSalt, ctx.user.PasswordHash))
        throw appError_('CURRENT_PASSWORD_INVALID', 'รหัสผ่านปัจจุบันไม่ถูกต้อง');
    if (current === next)
        throw appError_('PASSWORD_UNCHANGED', 'รหัสผ่านใหม่ต้องแตกต่างจากรหัสผ่านเดิม');
    const salt = createRandomToken_();
    updateObjectById_('Users', 'UserID', ctx.userId, { PasswordHash: passwordHash_(next, salt), PasswordSalt: salt, MustChangePassword: 'FALSE', PasswordChangedAt: nowIso_(), UpdatedAt: nowIso_(), UpdatedBy: ctx.userId });
    revokeUserSessionsExcept_(ctx.userId, hashSessionToken_(ctx.sessionToken));
    logAudit_({ departmentId: ctx.departmentId, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'CHANGE_PASSWORD', module: 'auth', description: 'เปลี่ยนรหัสผ่านของตนเอง' });
    return { changed: true };
}
function apiListRoles_(input, ctx) {
    if (ctx.roleCode !== 'SUPER_ADMIN' && ctx.roleCode !== 'DEPT_ADMIN')
        throw appError_('PERMISSION_DENIED', 'ไม่มีสิทธิ์ดูบทบาทระบบ');
    return paginate_(findObjects_('Roles', function (r) { return isTrue_(input.includeInactive) || isTrue_(r.IsActive); }, true).map(safeRecord_), input);
}
function apiSaveRole_(input, ctx) {
    if (ctx.roleCode !== 'SUPER_ADMIN')
        throw appError_('PERMISSION_DENIED', 'เฉพาะ Super Admin เท่านั้นที่จัดการบทบาทส่วนกลางได้');
    const code = String(input.roleCode || '').toUpperCase();
    if (!/^[A-Z0-9_]{2,40}$/.test(code))
        throw appError_('INVALID_ROLE_CODE', 'รหัสบทบาทไม่ถูกต้อง');
    const existing = findObjects_('Roles', function (r) { return r.RoleCode === code; }, true)[0];
    if (existing && isTrue_(existing.IsSystem) && input.allowSystemRoleEdit !== true)
        throw appError_('SYSTEM_ROLE_PROTECTED', 'บทบาทระบบถูกป้องกัน');
    const data = { RoleID: existing ? existing.RoleID : newId_('ROLE'), RoleCode: code, RoleName: String(input.roleName || '').trim(), Description: String(input.description || ''), IsSystem: existing ? existing.IsSystem : 'FALSE', IsActive: input.isActive === false ? 'FALSE' : 'TRUE', UpdatedAt: nowIso_(), UpdatedBy: ctx.userId };
    if (!data.RoleName)
        throw appError_('ROLE_NAME_REQUIRED', 'กรุณาระบุชื่อบทบาท');
    if (existing)
        updateObjectById_('Roles', 'RoleID', existing.RoleID, data);
    else {
        data.CreatedAt = nowIso_();
        data.CreatedBy = ctx.userId;
        appendObject_('Roles', data);
    }
    logAudit_({ departmentId: ctx.departmentId, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: existing ? 'UPDATE' : 'CREATE', module: 'roles', recordId: data.RoleID, description: 'บันทึกบทบาท ' + code });
    return safeRecord_(data);
}
function apiListPermissions_(input, ctx) {
    if (ctx.roleCode !== 'SUPER_ADMIN' && ctx.roleCode !== 'DEPT_ADMIN')
        throw appError_('PERMISSION_DENIED', 'ไม่มีสิทธิ์ดูสิทธิ์ระบบ');
    const rows = findObjects_('Permissions', function (r) { return (!input.roleCode || r.RoleCode === String(input.roleCode)) && (!input.module || r.Module === String(input.module)); }, true);
    return paginate_(rows.map(safeRecord_), input);
}
function apiSavePermissions_(input, ctx) {
    if (ctx.roleCode !== 'SUPER_ADMIN')
        throw appError_('PERMISSION_DENIED', 'เฉพาะ Super Admin เท่านั้นที่เปลี่ยน Permission Matrix ได้');
    const items = Array.isArray(input.permissions) ? input.permissions : [];
    if (!items.length)
        throw appError_('PERMISSION_LIST_REQUIRED', 'ไม่พบรายการสิทธิ์');
    let saved = 0;
    items.forEach(function (item) {
        const role = String(item.roleCode || '').toUpperCase(), moduleName = String(item.module || '').trim(), action = String(item.action || '').trim();
        if (!role || role === 'SUPER_ADMIN' || !moduleName || !action)
            return;
        const old = findObjects_('Permissions', function (r) { return r.RoleCode === role && r.Module === moduleName && r.Action === action; }, true)[0];
        const data = { PermissionID: old ? old.PermissionID : newId_('PERM'), RoleCode: role, Module: moduleName, Action: action, IsAllowed: isTrue_(item.isAllowed) ? 'TRUE' : 'FALSE', Scope: String(item.scope || 'DEPARTMENT'), Description: String(item.description || ''), UpdatedAt: nowIso_(), UpdatedBy: ctx.userId };
        if (old)
            updateObjectById_('Permissions', 'PermissionID', old.PermissionID, data);
        else {
            data.CreatedAt = nowIso_();
            data.CreatedBy = ctx.userId;
            appendObject_('Permissions', data);
        }
        saved++;
    });
    logAudit_({ departmentId: ctx.departmentId, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'SAVE', module: 'permissions', description: 'ปรับปรุงสิทธิ์ ' + saved + ' รายการ' });
    return { saved: saved };
}
function apiListPasswordResetRequests_(input, ctx) {
    const rows = findObjects_('PasswordResetRequests', function (r) { return (ctx.roleCode === 'SUPER_ADMIN' ? (!input.departmentId || r.DepartmentID === String(input.departmentId)) : r.DepartmentID === ctx.departmentId) && (!input.status || r.Status === input.status); }, true);
    return paginate_(rows.sort(function (a, b) { return String(b.RequestedAt).localeCompare(String(a.RequestedAt)); }), input);
}
function apiResolvePasswordResetRequest_(input, ctx) {
    const req = findObjectById_('PasswordResetRequests', 'RequestID', String(input.requestId || ''), true);
    if (!req || req.Status !== 'PENDING')
        throw appError_('RESET_REQUEST_NOT_FOUND', 'ไม่พบคำขอรีเซ็ตรหัสผ่านที่รอดำเนินการ');
    if (req.ExpiresAt && new Date(req.ExpiresAt).getTime() <= Date.now()) {
        updateObjectById_('PasswordResetRequests', 'RequestID', req.RequestID, { Status: 'EXPIRED' });
        throw appError_('RESET_REQUEST_EXPIRED', 'คำขอรีเซ็ตรหัสผ่านหมดอายุแล้ว');
    }
    assertDepartmentAccess_(ctx, req.DepartmentID);
    const target = findObjectById_('Users', 'UserID', req.UserID, false);
    if (!target)
        throw appError_('USER_NOT_FOUND', 'ไม่พบบัญชีผู้ใช้');
    const temp = String(input.temporaryPassword || '');
    validatePassword_(temp);
    const salt = createRandomToken_();
    updateObjectById_('Users', 'UserID', target.UserID, { PasswordHash: passwordHash_(temp, salt), PasswordSalt: salt, MustChangePassword: 'TRUE', FailedLoginCount: 0, LockedUntil: '', PasswordChangedAt: nowIso_(), LastPasswordResetAt: nowIso_(), UpdatedAt: nowIso_(), UpdatedBy: ctx.userId });
    updateObjectById_('PasswordResetRequests', 'RequestID', req.RequestID, { Status: 'APPROVED', ProcessedBy: ctx.userId, ProcessedAt: nowIso_() });
    revokeUserSessions_(target.UserID);
    logAudit_({ departmentId: req.DepartmentID, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'APPROVE_PASSWORD_RESET', module: 'users', recordId: req.RequestID, description: 'อนุมัติคำขอรีเซ็ตรหัสผ่าน' });
    return { approved: true, mustChangePassword: true };
}
function assertRoleAssignmentAllowed_(ctx, role) {
    if (ctx.roleCode === 'SUPER_ADMIN')
        return;
    if (role === 'SUPER_ADMIN' || role === 'DEPT_ADMIN')
        throw appError_('ROLE_ASSIGNMENT_DENIED', 'ไม่สามารถกำหนดบทบาทผู้ดูแลระบบได้');
    if (ctx.roleCode !== 'DEPT_ADMIN' && role !== 'STAFF')
        throw appError_('ROLE_ASSIGNMENT_DENIED', 'ไม่มีสิทธิ์กำหนดบทบาทนี้');
}
/* ========================================================================== */
/*  09. RECEIVE REGISTER                                                      */
/* ========================================================================== */
function apiListReceive_(input, ctx) {
    const rows = findObjects_('ReceiveRegister', function (r) {
        if (ctx.roleCode !== 'SUPER_ADMIN' && r.DepartmentID !== ctx.departmentId)
            return false;
        if (ctx.roleCode === 'SUPER_ADMIN' && input.departmentId && r.DepartmentID !== String(input.departmentId))
            return false;
        if (input.status && r.Status !== String(input.status))
            return false;
        if (input.year && String(r.RegisterYear) !== String(input.year))
            return false;
        if (input.responsibleUserId && r.ResponsibleUserID !== String(input.responsibleUserId))
            return false;
        if (input.dateFrom && r.ReceiveDate < String(input.dateFrom))
            return false;
        if (input.dateTo && r.ReceiveDate > String(input.dateTo))
            return false;
        return true;
    });
    return paginate_(filterSearch_(rows, input.search, ['RegisterNo', 'BookNo', 'Subject', 'FromOrganization', 'FromDepartment', 'Keywords', 'SearchText']), input, 'ReceiveDate');
}
function apiGetReceive_(input, ctx) { return getScopedRecord_('ReceiveRegister', 'RecordID', input.recordId, ctx); }
function getOperationDepartment_(input, ctx) {
    const departmentId = ctx.roleCode === 'SUPER_ADMIN' && input.departmentId ? String(input.departmentId) : ctx.departmentId;
    const department = findObjectById_('Departments', 'DepartmentID', departmentId, false);
    if (!department || department.Status !== 'ACTIVE')
        throw appError_('DEPARTMENT_NOT_FOUND', 'ไม่พบหน่วยงานที่ใช้งานได้');
    assertDepartmentAccess_(ctx, departmentId);
    return { departmentId: departmentId, department: department };
}
function apiCreateReceive_(input, ctx) {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
        return createReceiveRecordLocked_(input, ctx);
    }
    finally {
        lock.releaseLock();
    }
}
function createReceiveRecordLocked_(input, ctx) {
    const target = getOperationDepartment_(input, ctx);
    const subject = String(input.subject || '').trim();
    if (!subject)
        throw appError_('SUBJECT_REQUIRED', 'กรุณาระบุเรื่องหนังสือ');
    const date = normalizeDateInput_(input.receiveDate) || todayDate_(), number = generateRegisterNumber_(target.departmentId, 'RECEIVE', date);
    const relatedSendId = String(input.referenceSendRecordId || ''), relatedDocumentId = String(input.relatedDocumentId || '');
    if (relatedSendId) {
        const linked = getScopedRecord_('SendRegister', 'RecordID', relatedSendId, ctx);
        if (linked.DepartmentID !== target.departmentId)
            throw appError_('CROSS_DEPARTMENT_LINK', 'หนังสือที่เชื่อมโยงต้องอยู่ในหน่วยงานเดียวกัน');
    }
    if (relatedDocumentId) {
        const linked = getScopedRecord_('Documents', 'DocumentID', relatedDocumentId, ctx);
        if (linked.DepartmentID !== target.departmentId)
            throw appError_('CROSS_DEPARTMENT_LINK', 'เอกสารที่เชื่อมโยงต้องอยู่ในหน่วยงานเดียวกัน');
    }
    const data = {
        RecordID: newId_('REC'), DepartmentID: target.departmentId, RegisterNo: number.registerNo, RegisterYear: number.year, FiscalYear: number.fiscalYear,
        ReceiveDate: date, ReceiveTime: String(input.receiveTime || nowTime_()), BookNo: String(input.bookNo || ''), BookDate: normalizeDateInput_(input.bookDate),
        FromOrganization: String(input.fromOrganization || ''), FromDepartment: String(input.fromDepartment || ''), FromPerson: String(input.fromPerson || ''), FromContact: String(input.fromContact || ''),
        Subject: subject, DocumentType: String(input.documentType || 'GENERAL'), UrgencyLevel: String(input.urgencyLevel || 'NORMAL'),
        ConfidentialityLevel: String(input.confidentialityLevel || 'NORMAL'), NumberOfPages: clampNumber_(input.numberOfPages, 0, 100000, 0), AttachmentCount: 0,
        ReceivedByUserID: ctx.userId, ResponsibleUserID: String(input.responsibleUserId || ''), ResponsibleDepartmentID: target.departmentId,
        DueDate: normalizeDateInput_(input.dueDate) || addDaysToDate_(date, getSettingNumber_(target.departmentId, 'DEFAULT_DUE_DAYS', 7)),
        Status: String(input.status || 'PENDING').toUpperCase(), CompletionDate: normalizeDateInput_(input.completionDate), ReferenceSendRecordID: relatedSendId, RelatedDocumentID: relatedDocumentId,
        DistributionMethod: String(input.distributionMethod || ''), Keywords: String(input.keywords || ''), SearchText: buildSearchText_([subject, input.bookNo, input.fromOrganization, input.fromDepartment, input.keywords]),
        Notes: String(input.notes || ''), CreatedAt: nowIso_(), CreatedBy: ctx.userId
    };
    if (!['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'ON_HOLD'].includes(data.Status))
        throw appError_('INVALID_RECORD_STATUS', 'สถานะหนังสือรับไม่ถูกต้อง');
    if (data.Status === 'COMPLETED' && !data.CompletionDate)
        data.CompletionDate = date;
    if (data.ResponsibleUserID) {
        const responsible = findObjectById_('Users', 'UserID', data.ResponsibleUserID, false);
        if (!responsible || responsible.DepartmentID !== target.departmentId || responsible.Status !== 'ACTIVE')
            throw appError_('RESPONSIBLE_USER_INVALID', 'ผู้รับผิดชอบต้องเป็นผู้ใช้ที่ใช้งานได้ในหน่วยงานเดียวกัน');
    }
    appendObject_('ReceiveRegister', data);
    if (data.ResponsibleUserID)
        createNotification_({ departmentId: target.departmentId, userId: data.ResponsibleUserID, type: 'NEW_RECEIVE', title: 'มีหนังสือรับใหม่', message: 'หนังสือเลขรับ ' + data.RegisterNo + ' เรื่อง ' + data.Subject, linkType: 'RECEIVE', linkId: data.RecordID, createdBy: ctx.userId });
    createWorkflowEntry_({ departmentId: target.departmentId, recordId: data.RecordID, recordType: 'RECEIVE', documentId: data.RelatedDocumentID, stepNo: 1, actionType: 'REGISTER', fromUserId: ctx.userId, toUserId: data.ResponsibleUserID, fromDepartmentId: target.departmentId, toDepartmentId: data.ResponsibleDepartmentID, actionNote: 'ลงทะเบียนหนังสือรับ', instruction: '', status: 'REGISTERED', createdBy: ctx.userId });
    logAudit_({ departmentId: target.departmentId, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'CREATE', module: 'receive', recordId: data.RecordID, description: 'ลงทะเบียนหนังสือรับเลขที่ ' + data.RegisterNo });
    return safeRecord_(data);
}
function apiUpdateReceive_(input, ctx) {
    const id = String(input.recordId || ''), current = getScopedRecord_('ReceiveRegister', 'RecordID', id, ctx), map = {
        receiveDate: 'ReceiveDate', receiveTime: 'ReceiveTime', bookNo: 'BookNo', bookDate: 'BookDate', fromOrganization: 'FromOrganization', fromDepartment: 'FromDepartment',
        fromPerson: 'FromPerson', fromContact: 'FromContact', subject: 'Subject', documentType: 'DocumentType', urgencyLevel: 'UrgencyLevel', confidentialityLevel: 'ConfidentialityLevel',
        numberOfPages: 'NumberOfPages', responsibleUserId: 'ResponsibleUserID', responsibleDepartmentId: 'ResponsibleDepartmentID', dueDate: 'DueDate', status: 'Status',
        completionDate: 'CompletionDate', distributionMethod: 'DistributionMethod', keywords: 'Keywords', notes: 'Notes'
    }, patch = {};
    Object.keys(map).forEach(function (key) { if (input[key] !== undefined)
        patch[map[key]] = input[key]; });
    ['ReceiveDate', 'BookDate', 'DueDate', 'CompletionDate'].forEach(function (key) { if (patch[key] !== undefined)
        patch[key] = normalizeDateInput_(patch[key]); });
    if (patch.Subject !== undefined && !String(patch.Subject).trim())
        throw appError_('SUBJECT_REQUIRED', 'กรุณาระบุเรื่องหนังสือ');
    if (patch.Status !== undefined && !['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'ON_HOLD'].includes(String(patch.Status).toUpperCase()))
        throw appError_('INVALID_RECORD_STATUS', 'สถานะหนังสือรับไม่ถูกต้อง');
    if (patch.Status !== undefined)
        patch.Status = String(patch.Status).toUpperCase();
    if (patch.ResponsibleDepartmentID !== undefined && String(patch.ResponsibleDepartmentID) !== current.DepartmentID)
        throw appError_('CROSS_DEPARTMENT_ASSIGNMENT', 'ไม่สามารถย้ายความรับผิดชอบไปอีกหน่วยงานผ่านทะเบียนรับได้');
    if (patch.ResponsibleUserID) {
        const responsible = findObjectById_('Users', 'UserID', patch.ResponsibleUserID, false);
        if (!responsible || responsible.DepartmentID !== current.DepartmentID || responsible.Status !== 'ACTIVE')
            throw appError_('RESPONSIBLE_USER_INVALID', 'ผู้รับผิดชอบต้องเป็นผู้ใช้ที่ใช้งานได้ในหน่วยงานเดียวกัน');
    }
    if (patch.Status === 'COMPLETED' && !patch.CompletionDate)
        patch.CompletionDate = todayDate_();
    patch.SearchText = buildSearchText_([patch.Subject || current.Subject, patch.BookNo || current.BookNo, patch.FromOrganization || current.FromOrganization, patch.FromDepartment || current.FromDepartment, patch.Keywords || current.Keywords]);
    patch.UpdatedAt = nowIso_();
    patch.UpdatedBy = ctx.userId;
    const updated = updateObjectById_('ReceiveRegister', 'RecordID', id, patch);
    if (patch.ResponsibleUserID && patch.ResponsibleUserID !== current.ResponsibleUserID)
        createNotification_({ departmentId: current.DepartmentID, userId: patch.ResponsibleUserID, type: 'RECEIVE_ASSIGNED', title: 'ได้รับมอบหมายหนังสือ', message: 'คุณได้รับมอบหมายหนังสือเลขรับ ' + current.RegisterNo, linkType: 'RECEIVE', linkId: id, createdBy: ctx.userId });
    logAudit_({ departmentId: current.DepartmentID, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'UPDATE', module: 'receive', recordId: id, description: 'แก้ไขทะเบียนหนังสือรับ ' + current.RegisterNo, before: current, after: updated });
    return safeRecord_(updated);
}
function apiDeleteReceive_(input, ctx) { return moveRecordToTrash_('ReceiveRegister', 'RecordID', String(input.recordId || ''), ctx, String(input.reason || '')); }
/* ========================================================================== */
/*  10. SEND REGISTER                                                         */
/* ========================================================================== */
function apiListSend_(input, ctx) {
    const rows = findObjects_('SendRegister', function (r) {
        if (ctx.roleCode !== 'SUPER_ADMIN' && r.DepartmentID !== ctx.departmentId)
            return false;
        if (ctx.roleCode === 'SUPER_ADMIN' && input.departmentId && r.DepartmentID !== String(input.departmentId))
            return false;
        if (input.status && r.Status !== String(input.status))
            return false;
        if (input.year && String(r.RegisterYear) !== String(input.year))
            return false;
        if (input.dateFrom && r.SendDate < String(input.dateFrom))
            return false;
        if (input.dateTo && r.SendDate > String(input.dateTo))
            return false;
        return true;
    });
    return paginate_(filterSearch_(rows, input.search, ['RegisterNo', 'BookNo', 'Subject', 'ToOrganization', 'ToDepartment', 'TrackingNumber', 'Keywords', 'SearchText']), input, 'SendDate');
}
function apiGetSend_(input, ctx) { return getScopedRecord_('SendRegister', 'RecordID', input.recordId, ctx); }
function apiCreateSend_(input, ctx) {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
        return createSendRecordLocked_(input, ctx);
    }
    finally {
        lock.releaseLock();
    }
}
function createSendRecordLocked_(input, ctx) {
    const target = getOperationDepartment_(input, ctx);
    const subject = String(input.subject || '').trim();
    if (!subject)
        throw appError_('SUBJECT_REQUIRED', 'กรุณาระบุเรื่องหนังสือ');
    const date = normalizeDateInput_(input.sendDate) || todayDate_(), number = generateRegisterNumber_(target.departmentId, 'SEND', date);
    const relatedReceiveId = String(input.relatedReceiveRecordId || ''), relatedDocumentId = String(input.relatedDocumentId || '');
    if (relatedReceiveId) {
        const linked = getScopedRecord_('ReceiveRegister', 'RecordID', relatedReceiveId, ctx);
        if (linked.DepartmentID !== target.departmentId)
            throw appError_('CROSS_DEPARTMENT_LINK', 'ทะเบียนรับที่เชื่อมโยงต้องอยู่ในหน่วยงานเดียวกัน');
    }
    if (relatedDocumentId) {
        const linked = getScopedRecord_('Documents', 'DocumentID', relatedDocumentId, ctx);
        if (linked.DepartmentID !== target.departmentId)
            throw appError_('CROSS_DEPARTMENT_LINK', 'เอกสารที่เชื่อมโยงต้องอยู่ในหน่วยงานเดียวกัน');
    }
    const data = {
        RecordID: newId_('SND'), DepartmentID: target.departmentId, RegisterNo: number.registerNo, RegisterYear: number.year, FiscalYear: number.fiscalYear,
        SendDate: date, SendTime: String(input.sendTime || nowTime_()), BookNo: String(input.bookNo || ''), BookDate: normalizeDateInput_(input.bookDate),
        ToOrganization: String(input.toOrganization || ''), ToDepartment: String(input.toDepartment || ''), ToPerson: String(input.toPerson || ''), ToAddress: String(input.toAddress || ''), ToContact: String(input.toContact || ''),
        Subject: subject, DocumentType: String(input.documentType || 'GENERAL'), UrgencyLevel: String(input.urgencyLevel || 'NORMAL'), ConfidentialityLevel: String(input.confidentialityLevel || 'NORMAL'),
        NumberOfPages: clampNumber_(input.numberOfPages, 0, 100000, 0), AttachmentCount: 0, PreparedByUserID: ctx.userId, ApprovedByUserID: String(input.approvedByUserId || ''),
        ResponsibleUserID: String(input.responsibleUserId || (ctx.roleCode === 'SUPER_ADMIN' ? '' : ctx.userId)), Status: String(input.status || 'DRAFT').toUpperCase(),
        DueDate: normalizeDateInput_(input.dueDate) || addDaysToDate_(date, getSettingNumber_(target.departmentId, 'DEFAULT_DUE_DAYS', 7)), CompletionDate: normalizeDateInput_(input.completionDate),
        DispatchMethod: String(input.dispatchMethod || ''), TrackingNumber: String(input.trackingNumber || ''), DispatchDate: normalizeDateInput_(input.dispatchDate), DeliveryDate: normalizeDateInput_(input.deliveryDate),
        RelatedReceiveRecordID: relatedReceiveId, RelatedDocumentID: relatedDocumentId, Keywords: String(input.keywords || ''),
        SearchText: buildSearchText_([subject, input.bookNo, input.toOrganization, input.toDepartment, input.keywords]), Notes: String(input.notes || ''), CreatedAt: nowIso_(), CreatedBy: ctx.userId
    };
    if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'DISPATCHED', 'DELIVERED', 'CANCELLED'].includes(data.Status))
        throw appError_('INVALID_RECORD_STATUS', 'สถานะหนังสือส่งไม่ถูกต้อง');
    if (data.Status === 'DELIVERED' && !data.CompletionDate)
        data.CompletionDate = data.DeliveryDate || todayDate_();
    if (data.ResponsibleUserID) {
        const responsible = findObjectById_('Users', 'UserID', data.ResponsibleUserID, false);
        if (!responsible || responsible.DepartmentID !== target.departmentId || responsible.Status !== 'ACTIVE')
            throw appError_('RESPONSIBLE_USER_INVALID', 'ผู้รับผิดชอบต้องเป็นผู้ใช้ที่ใช้งานได้ในหน่วยงานเดียวกัน');
    }
    appendObject_('SendRegister', data);
    createWorkflowEntry_({ departmentId: target.departmentId, recordId: data.RecordID, recordType: 'SEND', documentId: data.RelatedDocumentID, stepNo: 1, actionType: 'REGISTER', fromUserId: ctx.userId, toUserId: data.ResponsibleUserID, fromDepartmentId: target.departmentId, toDepartmentId: target.departmentId, actionNote: 'จัดทำทะเบียนหนังสือส่ง', instruction: '', status: 'REGISTERED', createdBy: ctx.userId });
    logAudit_({ departmentId: target.departmentId, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'CREATE', module: 'send', recordId: data.RecordID, description: 'ลงทะเบียนหนังสือส่งเลขที่ ' + data.RegisterNo });
    return safeRecord_(data);
}
function apiUpdateSend_(input, ctx) {
    const id = String(input.recordId || ''), current = getScopedRecord_('SendRegister', 'RecordID', id, ctx), map = {
        sendDate: 'SendDate', sendTime: 'SendTime', bookNo: 'BookNo', bookDate: 'BookDate', toOrganization: 'ToOrganization', toDepartment: 'ToDepartment', toPerson: 'ToPerson',
        toAddress: 'ToAddress', toContact: 'ToContact', subject: 'Subject', documentType: 'DocumentType', urgencyLevel: 'UrgencyLevel', confidentialityLevel: 'ConfidentialityLevel',
        numberOfPages: 'NumberOfPages', approvedByUserId: 'ApprovedByUserID', responsibleUserId: 'ResponsibleUserID', status: 'Status', dueDate: 'DueDate', completionDate: 'CompletionDate', dispatchMethod: 'DispatchMethod',
        trackingNumber: 'TrackingNumber', dispatchDate: 'DispatchDate', deliveryDate: 'DeliveryDate', keywords: 'Keywords', notes: 'Notes'
    }, patch = {};
    Object.keys(map).forEach(function (key) { if (input[key] !== undefined)
        patch[map[key]] = input[key]; });
    ['SendDate', 'BookDate', 'DueDate', 'CompletionDate', 'DispatchDate', 'DeliveryDate'].forEach(function (key) { if (patch[key] !== undefined)
        patch[key] = normalizeDateInput_(patch[key]); });
    if (patch.Subject !== undefined && !String(patch.Subject).trim())
        throw appError_('SUBJECT_REQUIRED', 'กรุณาระบุเรื่องหนังสือ');
    if (patch.Status !== undefined && !['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'DISPATCHED', 'DELIVERED', 'CANCELLED'].includes(String(patch.Status).toUpperCase()))
        throw appError_('INVALID_RECORD_STATUS', 'สถานะหนังสือส่งไม่ถูกต้อง');
    if (patch.Status !== undefined)
        patch.Status = String(patch.Status).toUpperCase();
    if (patch.Status === 'DELIVERED' && !patch.CompletionDate)
        patch.CompletionDate = todayDate_();
    if (patch.ResponsibleUserID) {
        const responsible = findObjectById_('Users', 'UserID', patch.ResponsibleUserID, false);
        if (!responsible || responsible.DepartmentID !== current.DepartmentID || responsible.Status !== 'ACTIVE')
            throw appError_('RESPONSIBLE_USER_INVALID', 'ผู้รับผิดชอบต้องเป็นผู้ใช้ที่ใช้งานได้ในหน่วยงานเดียวกัน');
    }
    patch.SearchText = buildSearchText_([patch.Subject || current.Subject, patch.BookNo || current.BookNo, patch.ToOrganization || current.ToOrganization, patch.ToDepartment || current.ToDepartment, patch.Keywords || current.Keywords]);
    patch.UpdatedAt = nowIso_();
    patch.UpdatedBy = ctx.userId;
    const updated = updateObjectById_('SendRegister', 'RecordID', id, patch);
    logAudit_({ departmentId: current.DepartmentID, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'UPDATE', module: 'send', recordId: id, description: 'แก้ไขทะเบียนหนังสือส่ง ' + current.RegisterNo, before: current, after: updated });
    return safeRecord_(updated);
}
function apiDeleteSend_(input, ctx) { return moveRecordToTrash_('SendRegister', 'RecordID', String(input.recordId || ''), ctx, String(input.reason || '')); }
/* ========================================================================== */
/*  11. DOCUMENTS                                                             */
/* ========================================================================== */
function apiListDocuments_(input, ctx) {
    const rows = findObjects_('Documents', function (r) {
        if (ctx.roleCode !== 'SUPER_ADMIN' && r.DepartmentID !== ctx.departmentId)
            return false;
        if (ctx.roleCode === 'SUPER_ADMIN' && input.departmentId && r.DepartmentID !== String(input.departmentId))
            return false;
        if (input.documentType && r.DocumentType !== String(input.documentType))
            return false;
        if (input.status && r.Status !== String(input.status))
            return false;
        return true;
    });
    return paginate_(filterSearch_(rows, input.search, ['DocumentCode', 'Title', 'Subject', 'BookNo', 'FromOrganization', 'ToOrganization', 'Keywords', 'SearchText']), input, 'CreatedAt');
}
function apiGetDocument_(input, ctx) {
    const document = getScopedRecord_('Documents', 'DocumentID', input.documentId, ctx);
    document.attachments = findObjects_('Attachments', function (r) { return r.DocumentID === document.DocumentID && r.Status === 'ACTIVE'; }).map(safeRecord_);
    return document;
}
function apiCreateDocument_(input, ctx) {
    const target = getOperationDepartment_(input, ctx);
    const title = String(input.title || '').trim();
    if (!title)
        throw appError_('TITLE_REQUIRED', 'กรุณาระบุชื่อเอกสาร');
    const sourceRecordId = String(input.sourceRecordId || ''), sourceRecordType = normalizeRecordType_(input.sourceRecordType || '');
    if (sourceRecordId && sourceRecordType === 'RECEIVE') {
        const linked = getScopedRecord_('ReceiveRegister', 'RecordID', sourceRecordId, ctx);
        if (linked.DepartmentID !== target.departmentId)
            throw appError_('CROSS_DEPARTMENT_LINK', 'ทะเบียนต้นทางต้องอยู่ในหน่วยงานเดียวกัน');
    }
    else if (sourceRecordId && sourceRecordType === 'SEND') {
        const linked = getScopedRecord_('SendRegister', 'RecordID', sourceRecordId, ctx);
        if (linked.DepartmentID !== target.departmentId)
            throw appError_('CROSS_DEPARTMENT_LINK', 'ทะเบียนต้นทางต้องอยู่ในหน่วยงานเดียวกัน');
    }
    else if (sourceRecordId)
        throw appError_('INVALID_SOURCE_RECORD_TYPE', 'ประเภททะเบียนต้นทางไม่ถูกต้อง');
    const data = {
        DocumentID: newId_('DOC'), DepartmentID: target.departmentId, DocumentCode: String(input.documentCode || newId_('D')).replace(/\s/g, ''),
        Title: title, Subject: String(input.subject || title), DocumentType: String(input.documentType || 'GENERAL'), Direction: String(input.direction || 'INTERNAL'),
        SourceRecordID: sourceRecordId, SourceRecordType: sourceRecordType, BookNo: String(input.bookNo || ''), BookDate: normalizeDateInput_(input.bookDate),
        FromOrganization: String(input.fromOrganization || ''), ToOrganization: String(input.toOrganization || ''), OwnerUserID: ctx.userId,
        ResponsibleUserID: String(input.responsibleUserId || (ctx.roleCode === 'SUPER_ADMIN' ? '' : ctx.userId)), Status: String(input.status || 'ACTIVE'),
        ConfidentialityLevel: String(input.confidentialityLevel || 'NORMAL'), UrgencyLevel: String(input.urgencyLevel || 'NORMAL'), CurrentVersion: 1,
        Keywords: String(input.keywords || ''), SearchText: buildSearchText_([title, input.subject, input.bookNo, input.keywords]), Notes: String(input.notes || ''), CreatedAt: nowIso_(), CreatedBy: ctx.userId
    };
    if (data.ResponsibleUserID) {
        const responsible = findObjectById_('Users', 'UserID', data.ResponsibleUserID, false);
        if (!responsible || responsible.DepartmentID !== target.departmentId || responsible.Status !== 'ACTIVE')
            throw appError_('RESPONSIBLE_USER_INVALID', 'ผู้รับผิดชอบต้องเป็นผู้ใช้ที่ใช้งานได้ในหน่วยงานเดียวกัน');
    }
    appendObject_('Documents', data);
    logAudit_({ departmentId: target.departmentId, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'CREATE', module: 'documents', recordId: data.DocumentID, description: 'สร้างเอกสาร ' + title });
    return safeRecord_(data);
}
function apiUpdateDocument_(input, ctx) {
    const id = String(input.documentId || ''), current = getScopedRecord_('Documents', 'DocumentID', id, ctx), map = {
        title: 'Title', subject: 'Subject', documentType: 'DocumentType', direction: 'Direction', bookNo: 'BookNo', bookDate: 'BookDate',
        fromOrganization: 'FromOrganization', toOrganization: 'ToOrganization', responsibleUserId: 'ResponsibleUserID', status: 'Status',
        confidentialityLevel: 'ConfidentialityLevel', urgencyLevel: 'UrgencyLevel', keywords: 'Keywords', notes: 'Notes'
    }, patch = {};
    Object.keys(map).forEach(function (key) { if (input[key] !== undefined)
        patch[map[key]] = input[key]; });
    if (patch.BookDate !== undefined)
        patch.BookDate = normalizeDateInput_(patch.BookDate);
    if (patch.Title !== undefined && !String(patch.Title).trim())
        throw appError_('TITLE_REQUIRED', 'กรุณาระบุชื่อเอกสาร');
    if (patch.ResponsibleUserID) {
        const responsible = findObjectById_('Users', 'UserID', patch.ResponsibleUserID, false);
        if (!responsible || responsible.DepartmentID !== current.DepartmentID || responsible.Status !== 'ACTIVE')
            throw appError_('RESPONSIBLE_USER_INVALID', 'ผู้รับผิดชอบต้องเป็นผู้ใช้ที่ใช้งานได้ในหน่วยงานเดียวกัน');
    }
    patch.SearchText = buildSearchText_([patch.Title || current.Title, patch.Subject || current.Subject, patch.BookNo || current.BookNo, patch.Keywords || current.Keywords]);
    patch.UpdatedAt = nowIso_();
    patch.UpdatedBy = ctx.userId;
    const updated = updateObjectById_('Documents', 'DocumentID', id, patch);
    logAudit_({ departmentId: current.DepartmentID, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'UPDATE', module: 'documents', recordId: id, description: 'แก้ไขเอกสาร ' + current.Title, before: current, after: updated });
    return safeRecord_(updated);
}
function apiDeleteDocument_(input, ctx) { return moveRecordToTrash_('Documents', 'DocumentID', String(input.documentId || ''), ctx, String(input.reason || '')); }
/* ========================================================================== */
/*  12. ATTACHMENTS, PRIVATE DRIVE AND BROWSER DOWNLOADS                       */
/* ========================================================================== */
function apiListAttachments_(input, ctx) {
    const rows = findObjects_('Attachments', function (r) {
        if (ctx.roleCode !== 'SUPER_ADMIN' && r.DepartmentID !== ctx.departmentId)
            return false;
        if (ctx.roleCode === 'SUPER_ADMIN' && input.departmentId && r.DepartmentID !== String(input.departmentId))
            return false;
        if (input.documentId && r.DocumentID !== String(input.documentId))
            return false;
        if (input.recordId && r.RecordID !== String(input.recordId))
            return false;
        if (input.recordType && r.RecordType !== String(input.recordType))
            return false;
        if (!isTrue_(input.includeInactive) && r.Status !== 'ACTIVE')
            return false;
        return true;
    });
    return paginate_(rows.map(safeRecord_), input, 'UploadedAt');
}
function apiUploadAttachment_(input, ctx) {
    const fileName = sanitizeFileName_(input.fileName || input.originalFileName || 'document.bin');
    const mimeType = String(input.mimeType || 'application/octet-stream'), base64 = String(input.fileBase64 || '');
    if (!base64)
        throw appError_('FILE_DATA_REQUIRED', 'ไม่พบข้อมูลไฟล์');
    if (APP_CONFIG.DOCUMENT_MIME_TYPES.indexOf(mimeType) < 0)
        throw appError_('FILE_TYPE_NOT_ALLOWED', 'ไม่อนุญาตให้อัปโหลดไฟล์ชนิดนี้');
    const bytes = decodeBase64_(base64), max = getMaxUploadBytes_();
    if (bytes.length > max)
        throw appError_('FILE_TOO_LARGE', 'ไฟล์มีขนาดเกิน ' + formatBytes_(max));
    const recordType = normalizeRecordType_(input.recordType || 'DOCUMENT'), recordId = String(input.recordId || ''), documentId = String(input.documentId || '');
    if (recordId && recordType === 'RECEIVE')
        getScopedRecord_('ReceiveRegister', 'RecordID', recordId, ctx);
    else if (recordId && recordType === 'SEND')
        getScopedRecord_('SendRegister', 'RecordID', recordId, ctx);
    else if (recordId && recordType === 'DOCUMENT' && !documentId)
        getScopedRecord_('Documents', 'DocumentID', recordId, ctx);
    else if (recordId && !['RECEIVE', 'SEND', 'DOCUMENT'].includes(recordType))
        throw appError_('INVALID_RECORD_TYPE', 'ประเภทรายการแนบไฟล์ไม่ถูกต้อง');
    const target = getOperationDepartment_(input, ctx);
    if (documentId) {
        const doc = getScopedRecord_('Documents', 'DocumentID', documentId, ctx);
        if (doc.DepartmentID !== target.departmentId)
            throw appError_('CROSS_DEPARTMENT_FILE_LINK', 'ไฟล์แนบและเอกสารต้องอยู่ในหน่วยงานเดียวกัน');
    }
    if (recordId && ['RECEIVE', 'SEND', 'DOCUMENT'].includes(recordType)) {
        const parentType = recordType === 'RECEIVE' ? 'ReceiveRegister' : recordType === 'SEND' ? 'SendRegister' : 'Documents';
        const parentIdField = recordType === 'DOCUMENT' ? 'DocumentID' : 'RecordID';
        const parent = getScopedRecord_(parentType, parentIdField, recordId, ctx);
        if (parent.DepartmentID !== target.departmentId)
            throw appError_('CROSS_DEPARTMENT_FILE_LINK', 'ไฟล์แนบและรายการต้นทางต้องอยู่ในหน่วยงานเดียวกัน');
    }
    const folders = ensureDepartmentFolders_(target.departmentId, target.department.DepartmentCode);
    const file = DriveApp.getFolderById(folders.originalsFolderId).createFile(Utilities.newBlob(bytes, mimeType, fileName));
    const attachment = {
        AttachmentID: newId_('ATT'), DepartmentID: target.departmentId, DocumentID: documentId, RecordID: recordId, RecordType: recordType,
        AttachmentCategory: String(input.attachmentCategory || 'GENERAL'), FileName: file.getName(), OriginalFileName: String(input.originalFileName || fileName),
        FileExtension: getFileExtension_(fileName), MimeType: mimeType, FileSizeBytes: bytes.length, DriveFileID: file.getId(), DriveFolderID: folders.originalsFolderId,
        StorageProvider: 'GOOGLE_DRIVE_PRIVATE', IsMainFile: isTrue_(input.isMainFile) ? 'TRUE' : 'FALSE', IsPasswordProtectedSource: 'FALSE',
        ChecksumSHA256: sha256Base64_(bytes), UploadedByUserID: ctx.userId, UploadedAt: nowIso_(), Status: 'ACTIVE',
        Notes: String(input.notes || ''), CreatedAt: nowIso_(), CreatedBy: ctx.userId
    };
    file.setDescription('Document Registry attachment; DepartmentID=' + target.departmentId + '; AttachmentID=' + attachment.AttachmentID);
    appendObject_('Attachments', attachment);
    if (documentId && isTrue_(attachment.IsMainFile)) {
        const doc = findObjectById_('Documents', 'DocumentID', documentId, false);
        updateObjectById_('Documents', 'DocumentID', documentId, { MainAttachmentID: attachment.AttachmentID, CurrentVersion: Number(doc.CurrentVersion || 0) + 1, UpdatedAt: nowIso_(), UpdatedBy: ctx.userId });
    }
    if (recordType === 'RECEIVE' && recordId)
        updateAttachmentCount_('ReceiveRegister', 'RecordID', recordId, 1);
    if (recordType === 'SEND' && recordId)
        updateAttachmentCount_('SendRegister', 'RecordID', recordId, 1);
    logAudit_({ departmentId: target.departmentId, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'UPLOAD', module: 'attachments', recordId: attachment.AttachmentID, description: 'อัปโหลดไฟล์ ' + fileName });
    return safeRecord_(attachment);
}
function apiDownloadAttachment_(input, ctx) {
    const id = String(input.attachmentId || ''), attachment = findObjectById_('Attachments', 'AttachmentID', id, false);
    if (!attachment || attachment.Status !== 'ACTIVE')
        throw appError_('ATTACHMENT_NOT_FOUND', 'ไม่พบไฟล์แนบ');
    assertDepartmentAccess_(ctx, attachment.DepartmentID);
    if (attachment.RecordID && attachment.RecordType === 'RECEIVE' && !findObjectById_('ReceiveRegister', 'RecordID', attachment.RecordID, false))
        throw appError_('ATTACHMENT_PARENT_DELETED', 'ทะเบียนต้นทางถูกลบหรือไม่พร้อมใช้งาน');
    if (attachment.RecordID && attachment.RecordType === 'SEND' && !findObjectById_('SendRegister', 'RecordID', attachment.RecordID, false))
        throw appError_('ATTACHMENT_PARENT_DELETED', 'ทะเบียนต้นทางถูกลบหรือไม่พร้อมใช้งาน');
    if (attachment.DocumentID && !findObjectById_('Documents', 'DocumentID', attachment.DocumentID, false))
        throw appError_('ATTACHMENT_PARENT_DELETED', 'เอกสารต้นทางถูกลบหรือไม่พร้อมใช้งาน');
    const file = getPrivateDriveFile_(attachment.DriveFileID), bytes = file.getBlob().getBytes(), max = getMaxDownloadBytes_();
    if (bytes.length > max)
        throw appError_('DOWNLOAD_TOO_LARGE', 'ไฟล์มีขนาดเกินข้อจำกัด ' + formatBytes_(max) + ' ของการส่งผ่าน Apps Script');
    const requirePassword = true; // Mandatory policy: every downloaded attachment must be encrypted with a fresh unique password.
    let outputBytes = bytes, outputName = attachment.OriginalFileName || attachment.FileName, outputMime = attachment.MimeType || file.getMimeType(), password = '', passwordRef = '', algorithm = '';
    if (requirePassword) {
        const generated = generateUniqueFilePassword_(attachment.DepartmentID, ctx.userId, outputName);
        password = generated.password;
        passwordRef = generated.referenceId;
        try {
            const encrypted = encryptFileWithService_(bytes, outputName, outputMime, password);
            if (encrypted.bytes.length > max)
                throw appError_('DOWNLOAD_TOO_LARGE', 'ไฟล์หลังเข้ารหัสมีขนาดเกินข้อจำกัด ' + formatBytes_(max) + ' ของการส่งผ่าน Apps Script');
            outputBytes = encrypted.bytes;
            outputName = encrypted.fileName || outputName;
            outputMime = encrypted.mimeType || outputMime;
            algorithm = encrypted.algorithm;
            updateObjectById_('PasswordRecords', 'PasswordReferenceID', passwordRef, { Algorithm: algorithm, FileName: outputName, Status: 'ISSUED' });
        }
        catch (encryptionError) {
            updateObjectById_('PasswordRecords', 'PasswordReferenceID', passwordRef, { Status: 'FAILED' });
            throw encryptionError;
        }
    }
    const downloadId = newId_('DL');
    if (requirePassword)
        updateObjectById_('PasswordRecords', 'PasswordReferenceID', passwordRef, { DownloadID: downloadId, Algorithm: algorithm, FileName: outputName, Status: 'ISSUED' });
    appendObject_('DownloadLogs', { DownloadID: downloadId, DepartmentID: attachment.DepartmentID, UserID: ctx.userId, AttachmentID: attachment.AttachmentID, DocumentID: attachment.DocumentID, RecordID: attachment.RecordID, RecordType: attachment.RecordType, FileName: outputName, MimeType: outputMime, FileSizeBytes: outputBytes.length, PasswordProtected: requirePassword ? 'TRUE' : 'FALSE', PasswordReferenceID: passwordRef, DownloadStatus: 'READY', CreatedAt: nowIso_() });
    logAudit_({ departmentId: attachment.DepartmentID, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'DOWNLOAD', module: 'attachments', recordId: id, description: 'ดาวน์โหลดไฟล์ ' + outputName });
    return { downloadId: downloadId, fileName: outputName, mimeType: outputMime, fileSizeBytes: outputBytes.length, fileBase64: Utilities.base64Encode(outputBytes), passwordProtected: requirePassword, passwordReferenceId: passwordRef, maskedPassword: requirePassword ? APP_CONFIG.PASSWORD_DOWNLOAD_MASK : '', passwordForClipboard: password };
}
function apiDeleteAttachment_(input, ctx) {
    const id = String(input.attachmentId || '');
    return moveRecordToTrash_('Attachments', 'AttachmentID', id, ctx, String(input.reason || ''));
}
/* ========================================================================== */
/*  13A. ADOBE PDF SERVICES - CONFIGURATION AND AUTHENTICATION                 */
/* ========================================================================== */
/**
 * Returns Adobe credentials from Script Properties.
 * Never log or return this object to a browser/API response.
 */
function getAdobePdfServicesCredentials_() {
    const props = PropertiesService.getScriptProperties();
    return {
        clientId: String(props.getProperty(PROP.ADOBE_PDF_SERVICES_CLIENT_ID) || '').trim(),
        clientSecret: String(props.getProperty(PROP.ADOBE_PDF_SERVICES_CLIENT_SECRET) || '').trim()
    };
}

/** True only when both Adobe credentials have been configured. */
function isAdobePdfServicesConfigured_() {
    const credentials = getAdobePdfServicesCredentials_();
    return Boolean(credentials.clientId && credentials.clientSecret);
}

/**
 * Makes an Adobe JSON API request and returns its parsed JSON body.
 * Error messages intentionally include only the HTTP status, never response
 * bodies, tokens, document contents or password data.
 */
function adobeFetchJson_(url, options, errorCode, actionLabel) {
    const requestOptions = Object.assign({}, options || {}, {
        muteHttpExceptions: true
    });
    const response = UrlFetchApp.fetch(url, requestOptions);
    const status = response.getResponseCode();
    const responseText = response.getContentText() || '';

    if (status < 200 || status >= 300) {
        throw appError_(
            errorCode || 'ADOBE_API_FAILED',
            (actionLabel || 'Adobe PDF Services') + ' ไม่สำเร็จ (HTTP ' + status + ')'
        );
    }

    let result;
    try {
        result = responseText ? JSON.parse(responseText) : {};
    }
    catch (error) {
        throw appError_(
            'ADOBE_RESPONSE_INVALID',
            (actionLabel || 'Adobe PDF Services') + ' ส่งข้อมูลตอบกลับไม่ถูกต้อง'
        );
    }

    if (!result || typeof result !== 'object') {
        throw appError_(
            'ADOBE_RESPONSE_INVALID',
            (actionLabel || 'Adobe PDF Services') + ' ส่งข้อมูลตอบกลับไม่ถูกต้อง'
        );
    }

    return result;
}

/**
 * Retrieves and briefly caches an Adobe OAuth access token.
 * Adobe's token endpoint accepts application/x-www-form-urlencoded fields.
 */
function adobeGetAccessToken_() {
    const credentials = getAdobePdfServicesCredentials_();
    if (!credentials.clientId || !credentials.clientSecret) {
        throw appError_(
            'ADOBE_CREDENTIALS_MISSING',
            'กรุณาตั้งค่า ADOBE_PDF_SERVICES_CLIENT_ID และ ADOBE_PDF_SERVICES_CLIENT_SECRET ใน Script Properties'
        );
    }

    const cache = CacheService.getScriptCache();
    const cacheSuffix = sha256Base64_(credentials.clientId)
        .replace(/[^A-Za-z0-9]/g, '')
        .substring(0, 24);
    const cacheKey = 'ADOBE_PDF_ACCESS_TOKEN_' + cacheSuffix;
    const cachedToken = cache.get(cacheKey);
    if (cachedToken) {
        return cachedToken;
    }

    const tokenResult = adobeFetchJson_(
        'https://pdf-services.adobe.io/token',
        {
            method: 'post',
            contentType: 'application/x-www-form-urlencoded',
            payload: {
                client_id: credentials.clientId,
                client_secret: credentials.clientSecret
            }
        },
        'ADOBE_AUTH_FAILED',
        'ยืนยันตัวตนกับ Adobe'
    );

    if (!tokenResult.access_token) {
        throw appError_(
            'ADOBE_TOKEN_MISSING',
            'Adobe ไม่ส่ง Access Token กลับมา'
        );
    }

    const expiresIn = Number(tokenResult.expires_in || 3600);
    // Apps Script CacheService permits a maximum TTL of six hours. Avoid caching
    // tokens whose remaining lifetime is too short to cache safely.
    if (isFinite(expiresIn) && expiresIn > 120) {
        const cacheSeconds = Math.min(21600, Math.floor(expiresIn - 60));
        cache.put(cacheKey, String(tokenResult.access_token), cacheSeconds);
    }

    return String(tokenResult.access_token);
}

/* ========================================================================== */
/*  13B. ADOBE PDF SERVICES - URL VALIDATION AND RESPONSE HELPERS              */
/* ========================================================================== */
/** Extracts a strict HTTPS hostname; URLs containing credentials or ports are rejected. */
function adobeGetHttpsHost_(url) {
    const value = String(url || '').trim();
    const match = value.match(/^https:\/\/([a-z0-9.-]+)(?:\/|\?|#|$)/i);
    if (!match) {
        throw appError_('ADOBE_URL_INVALID', 'Adobe ส่ง URL ที่ไม่ใช่ HTTPS หรือมีรูปแบบไม่ถูกต้อง');
    }
    return match[1].toLowerCase();
}

/** Validates the pre-signed cloud-storage URL returned by Adobe. */
function adobeValidateStorageUrl_(url, purpose) {
    const value = String(url || '').trim();
    const host = adobeGetHttpsHost_(value);
    if (host !== 'amazonaws.com' && !host.endsWith('.amazonaws.com')) {
        throw appError_(
            'ADOBE_STORAGE_HOST_INVALID',
            'Adobe ส่ง URL จัดเก็บไฟล์จาก Host ที่ไม่ได้รับอนุญาต'
        );
    }
    return value;
}

/** Validates the status Location returned by Adobe's Protect PDF operation. */
function adobeValidateJobLocation_(location) {
    let value = String(location || '').trim();
    if (!value) {
        throw appError_('ADOBE_JOB_LOCATION_MISSING', 'ไม่พบ Location สำหรับตรวจสอบสถานะงาน Adobe');
    }

    if (value.charAt(0) === '/') {
        value = 'https://pdf-services.adobe.io' + value;
    }

    const host = adobeGetHttpsHost_(value);
    const allowedHosts = [
        'pdf-services.adobe.io',
        'pdf-services-ue1.adobe.io',
        'pdf-services-ew1.adobe.io'
    ];
    if (allowedHosts.indexOf(host) < 0) {
        throw appError_('ADOBE_JOB_HOST_INVALID', 'Adobe ส่ง Job Location จาก Host ที่ไม่ได้รับอนุญาต');
    }

    const pathMatch = value.match(/^https:\/\/[^/?#]+([^?#]*)/i);
    const path = pathMatch ? pathMatch[1] : '';
    if (path.indexOf('/operation/protectpdf/') !== 0) {
        throw appError_('ADOBE_JOB_PATH_INVALID', 'Adobe ส่ง Job Location สำหรับ Protect PDF ไม่ถูกต้อง');
    }

    // The Location header is the authoritative polling URL. Keep it as returned.
    return value;
}

/** Reads an HTTP response header without assuming header-name casing. */
function adobeGetResponseHeader_(response, headerName) {
    const headers = response.getAllHeaders();
    const target = String(headerName || '').toLowerCase();
    for (const key in headers) {
        if (String(key).toLowerCase() === target) {
            const value = headers[key];
            return Array.isArray(value) ? String(value[0] || '') : String(value || '');
        }
    }
    return '';
}

/** Confirms that a byte array begins with the PDF file signature. */
function adobeAssertPdfBytes_(bytes) {
    if (!bytes || !bytes.length || bytes.length < 5) {
        throw appError_('PDF_EMPTY', 'ไม่พบข้อมูล PDF หรือไฟล์มีขนาดเป็นศูนย์');
    }
    const signature = bytes.slice(0, 5).map(function (value) {
        return String.fromCharCode(value & 255);
    }).join('');
    if (signature !== '%PDF-') {
        throw appError_('INVALID_PDF_SIGNATURE', 'ไฟล์ที่ส่งให้ Adobe ไม่ใช่ PDF ที่ถูกต้อง');
    }
    return true;
}

/* ========================================================================== */
/*  13C. ADOBE PDF SERVICES - UPLOAD SOURCE PDF                                */
/* ========================================================================== */
/**
 * Creates an Adobe Asset and uploads PDF bytes to its pre-signed upload URI.
 * The pre-signed URI is used only in this server-side request and is not stored.
 */
function adobeUploadPdfAsset_(pdfBytes, accessToken) {
    adobeAssertPdfBytes_(pdfBytes);

    const credentials = getAdobePdfServicesCredentials_();
    const assetRequest = adobeFetchJson_(
        'https://pdf-services.adobe.io/assets',
        {
            method: 'post',
            contentType: 'application/json',
            headers: {
                'x-api-key': credentials.clientId,
                'Authorization': 'Bearer ' + accessToken
            },
            payload: JSON.stringify({
                mediaType: 'application/pdf'
            })
        },
        'ADOBE_ASSET_CREATE_FAILED',
        'สร้าง Adobe Asset'
    );

    if (!assetRequest.uploadUri || !assetRequest.assetID) {
        throw appError_(
            'ADOBE_ASSET_RESPONSE_INVALID',
            'Adobe ไม่ส่ง Upload URI หรือ Asset ID กลับมา'
        );
    }

    const uploadUri = adobeValidateStorageUrl_(assetRequest.uploadUri, 'upload');
    const uploadResponse = UrlFetchApp.fetch(
        uploadUri,
        {
            method: 'put',
            contentType: 'application/pdf',
            payload: pdfBytes,
            muteHttpExceptions: true
        }
    );

    const uploadStatus = uploadResponse.getResponseCode();
    if (uploadStatus < 200 || uploadStatus >= 300) {
        throw appError_(
            'ADOBE_UPLOAD_FAILED',
            'อัปโหลด PDF ไปยัง Adobe ไม่สำเร็จ (HTTP ' + uploadStatus + ')'
        );
    }

    return {
        assetID: String(assetRequest.assetID)
    };
}

/* ========================================================================== */
/*  13D. ADOBE PDF SERVICES - SUBMIT PROTECT PDF JOB                           */
/* ========================================================================== */
/** Submits a Protect PDF job using Adobe's AES_256 user/open password option. */
function adobeSubmitProtectPdf_(assetID, password, accessToken) {
    const credentials = getAdobePdfServicesCredentials_();
    const response = UrlFetchApp.fetch(
        'https://pdf-services.adobe.io/operation/protectpdf',
        {
            method: 'post',
            contentType: 'application/json',
            headers: {
                'x-api-key': credentials.clientId,
                'Authorization': 'Bearer ' + accessToken
            },
            payload: JSON.stringify({
                passwordProtection: {
                    userPassword: String(password)
                },
                encryptionAlgorithm: 'AES_256',
                assetID: String(assetID)
            }),
            muteHttpExceptions: true
        }
    );

    const status = response.getResponseCode();
    if (status < 200 || status >= 300) {
        throw appError_(
            'ADOBE_PROTECT_FAILED',
            'Adobe ไม่สามารถเริ่มกระบวนการเข้ารหัส PDF ได้ (HTTP ' + status + ')'
        );
    }

    const location = adobeGetResponseHeader_(response, 'location');
    if (!location) {
        throw appError_(
            'ADOBE_JOB_LOCATION_MISSING',
            'Adobe ไม่ส่ง Job Location กลับมา'
        );
    }

    return adobeValidateJobLocation_(location);
}

/* ========================================================================== */
/*  13E. ADOBE PDF SERVICES - POLL JOB AND GET OUTPUT URI                      */
/* ========================================================================== */
/**
 * Polls the Location returned by Adobe until status is done or failed.
 * The status URL is not reconstructed; the returned Location is authoritative.
 */
function adobeWaitForProtectJob_(location, accessToken) {
    const credentials = getAdobePdfServicesCredentials_();
    const statusUrl = adobeValidateJobLocation_(location);
    const headers = {
        'x-api-key': credentials.clientId,
        'Authorization': 'Bearer ' + accessToken
    };
    const maxAttempts = 40;
    const pollIntervalMs = 1500;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const response = UrlFetchApp.fetch(
            statusUrl,
            {
                method: 'get',
                headers: headers,
                muteHttpExceptions: true
            }
        );

        const httpStatus = response.getResponseCode();
        if (httpStatus === 429 || httpStatus >= 500) {
            Utilities.sleep(pollIntervalMs);
            continue;
        }
        if (httpStatus < 200 || httpStatus >= 300) {
            throw appError_(
                'ADOBE_STATUS_FAILED',
                'ตรวจสอบสถานะงาน Adobe ไม่สำเร็จ (HTTP ' + httpStatus + ')'
            );
        }

        let result;
        try {
            result = JSON.parse(response.getContentText() || '{}');
        }
        catch (error) {
            throw appError_('ADOBE_STATUS_INVALID', 'Adobe ส่งสถานะงานในรูปแบบที่ไม่ถูกต้อง');
        }

        const jobStatus = String(result.status || '')
            .toLowerCase()
            .replace(/[\s_-]/g, '');

        if (jobStatus === 'done') {
            const resultAsset = result.asset ||
                (result.result && result.result.asset) || {};
            const downloadUri = resultAsset.downloadUri ||
                result.downloadUri ||
                result.dowloadUri ||
                (result.result && (result.result.downloadUri || result.result.dowloadUri)) ||
                '';

            if (!downloadUri) {
                throw appError_(
                    'ADOBE_DOWNLOAD_URI_MISSING',
                    'Adobe ทำงานสำเร็จแต่ไม่ส่ง Download URI กลับมา'
                );
            }

            return adobeValidateStorageUrl_(downloadUri, 'download');
        }

        if (jobStatus === 'failed') {
            const errorCode = result.error && result.error.code
                ? String(result.error.code)
                : 'UNKNOWN';
            throw appError_(
                'ADOBE_JOB_FAILED',
                'Adobe เข้ารหัส PDF ไม่สำเร็จ (' + errorCode + ')'
            );
        }

        if (jobStatus !== 'inprogress' && jobStatus !== 'pending' && jobStatus !== 'running') {
            throw appError_(
                'ADOBE_JOB_STATUS_UNKNOWN',
                'Adobe ส่งสถานะงานที่ระบบไม่รู้จัก'
            );
        }

        Utilities.sleep(pollIntervalMs);
    }

    throw appError_(
        'ADOBE_JOB_TIMEOUT',
        'Adobe ใช้เวลาประมวลผลเกินกำหนด กรุณาลองดาวน์โหลดใหม่'
    );
}

/* ========================================================================== */
/*  13F. ADOBE PDF SERVICES - DOWNLOAD ENCRYPTED RESULT                        */
/* ========================================================================== */
/** Downloads the protected PDF from Adobe's short-lived pre-signed storage URI. */
function adobeDownloadProtectedPdf_(downloadUri) {
    const safeUri = adobeValidateStorageUrl_(downloadUri, 'download');
    const response = UrlFetchApp.fetch(
        safeUri,
        {
            method: 'get',
            muteHttpExceptions: true
        }
    );

    const status = response.getResponseCode();
    if (status !== 200) {
        throw appError_(
            'ADOBE_DOWNLOAD_FAILED',
            'ไม่สามารถดาวน์โหลด PDF ที่เข้ารหัสจาก Adobe ได้ (HTTP ' + status + ')'
        );
    }

    const outputBytes = response.getBlob().getBytes();
    adobeAssertPdfBytes_(outputBytes);
    return outputBytes;
}

/* ========================================================================== */
/*  13G. DOCUMENT REGISTRY - ENCRYPTION PROVIDER ADAPTER                       */
/* ========================================================================== */
/**
 * Keeps the existing download API contract unchanged while routing PDF files
 * through Adobe PDF Services. Non-PDF files fail closed; they are never returned
 * as if password protection had succeeded.
 */
function encryptFileWithService_(bytes, fileName, mimeType, password) {
    const extension = getFileExtension_(fileName);
    const normalizedMimeType = String(mimeType || '').toLowerCase();
    const isPdf = extension === 'pdf' || normalizedMimeType === 'application/pdf';

    if (!isPdf) {
        throw appError_(
            'ADOBE_PDF_ONLY',
            'Adobe PDF Services เข้ารหัสได้เฉพาะไฟล์ PDF เท่านั้น ไฟล์ชนิดอื่นยังไม่สามารถดาวน์โหลดแบบใส่รหัสผ่านได้'
        );
    }

    if (!isAdobePdfServicesConfigured_()) {
        throw appError_(
            'ADOBE_NOT_CONFIGURED',
            'ยังไม่ได้ตั้งค่า Adobe PDF Services Credentials จึงไม่สามารถดาวน์โหลดแบบใส่รหัสผ่านได้'
        );
    }

    adobeAssertPdfBytes_(bytes);

    if (!password || String(password).length < 8) {
        throw appError_(
            'PDF_PASSWORD_INVALID',
            'รหัสผ่าน PDF ที่ระบบสร้างมีความยาวไม่ถูกต้อง'
        );
    }

    const accessToken = adobeGetAccessToken_();
    const asset = adobeUploadPdfAsset_(bytes, accessToken);
    const location = adobeSubmitProtectPdf_(asset.assetID, password, accessToken);
    const downloadUri = adobeWaitForProtectJob_(location, accessToken);
    const encryptedBytes = adobeDownloadProtectedPdf_(downloadUri);

    let safeFileName = sanitizeFileName_(fileName);
    if (!/\.pdf$/i.test(safeFileName)) {
        safeFileName += '.pdf';
    }

    return {
        bytes: encryptedBytes,
        fileName: safeFileName,
        mimeType: 'application/pdf',
        algorithm: 'PDF_AES_256'
    };
}

function generateUniqueFilePassword_(departmentId, userId, fileName) {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
        for (let attempt = 0; attempt < 10; attempt++) {
            const password = generateFilePassword_(), fingerprint = filePasswordFingerprint_(password);
            if (!findObjects_('PasswordRecords', function (r) { return r.PasswordFingerprint === fingerprint; }, true)[0]) {
                const referenceId = newId_('PWR');
                appendObject_('PasswordRecords', { PasswordReferenceID: referenceId, DepartmentID: departmentId || '', UserID: userId || '', DownloadID: '', PasswordFingerprint: fingerprint, Algorithm: 'PENDING', FileName: String(fileName || ''), CreatedAt: nowIso_(), ExpiresAt: new Date(Date.now() + 86400000).toISOString(), Status: 'RESERVED' });
                return { password: password, referenceId: referenceId };
            }
        }
        throw appError_('PASSWORD_GENERATION_FAILED', 'ไม่สามารถสร้างรหัสผ่านที่ไม่ซ้ำได้ กรุณาลองใหม่');
    }
    finally {
        lock.releaseLock();
    }
}
function updateAttachmentCount_(sheetName, idField, id, delta) {
    const record = findObjectById_(sheetName, idField, id, false);
    if (!record)
        return;
    updateObjectById_(sheetName, idField, id, { AttachmentCount: Math.max(0, Number(record.AttachmentCount || 0) + Number(delta || 0)), UpdatedAt: nowIso_() });
}
/* ========================================================================== */
/*  13. STORE GENERATED PDF AND IMGBB IMAGE UPLOAD                            */
/* ========================================================================== */
function apiStoreGeneratedPdf_(input, ctx) {
    const target = getOperationDepartment_(input, ctx);
    const recordType = normalizeRecordType_(input.recordType || 'REPORT'), recordId = String(input.recordId || ''), documentId = String(input.documentId || '');
    if (recordId && recordType === 'RECEIVE') {
        const linked = getScopedRecord_('ReceiveRegister', 'RecordID', recordId, ctx);
        if (linked.DepartmentID !== target.departmentId)
            throw appError_('CROSS_DEPARTMENT_FILE_LINK', 'PDF และทะเบียนรับต้องอยู่ในหน่วยงานเดียวกัน');
    }
    else if (recordId && recordType === 'SEND') {
        const linked = getScopedRecord_('SendRegister', 'RecordID', recordId, ctx);
        if (linked.DepartmentID !== target.departmentId)
            throw appError_('CROSS_DEPARTMENT_FILE_LINK', 'PDF และทะเบียนส่งต้องอยู่ในหน่วยงานเดียวกัน');
    }
    else if (recordId && recordType === 'DOCUMENT' && !documentId) {
        const linked = getScopedRecord_('Documents', 'DocumentID', recordId, ctx);
        if (linked.DepartmentID !== target.departmentId)
            throw appError_('CROSS_DEPARTMENT_FILE_LINK', 'PDF และเอกสารต้องอยู่ในหน่วยงานเดียวกัน');
    }
    else if (recordId && !['RECEIVE', 'SEND', 'DOCUMENT'].includes(recordType))
        throw appError_('INVALID_RECORD_TYPE', 'ประเภทเอกสาร PDF ไม่ถูกต้อง');
    if (recordType === 'REPORT' && recordId)
        throw appError_('INVALID_RECORD_TYPE', 'รายงานไม่ควรมี Record ID ต้นทาง');
    if (documentId) {
        const doc = getScopedRecord_('Documents', 'DocumentID', documentId, ctx);
        if (doc.DepartmentID !== target.departmentId)
            throw appError_('CROSS_DEPARTMENT_FILE_LINK', 'PDF และเอกสารต้องอยู่ในหน่วยงานเดียวกัน');
    }
    const fileName = sanitizeFileName_(input.fileName || 'รายงาน.pdf'), mimeType = 'application/pdf', base64 = String(input.fileBase64 || '');
    if (!base64)
        throw appError_('PDF_DATA_REQUIRED', 'ไม่พบข้อมูล PDF');
    const bytes = decodeBase64_(base64);
    if (bytes.length > getMaxUploadBytes_())
        throw appError_('FILE_TOO_LARGE', 'ไฟล์ PDF มีขนาดเกินกำหนด');
    const folderIds = ensureDepartmentFolders_(target.departmentId, target.department.DepartmentCode);
    const file = DriveApp.getFolderById(folderIds.generatedFolderId).createFile(Utilities.newBlob(bytes, mimeType, fileName));
    const attachment = {
        AttachmentID: newId_('ATT'), DepartmentID: target.departmentId, DocumentID: documentId, RecordID: recordId,
        RecordType: recordType, AttachmentCategory: 'GENERATED_PDF', FileName: file.getName(), OriginalFileName: fileName,
        FileExtension: 'pdf', MimeType: mimeType, FileSizeBytes: bytes.length, DriveFileID: file.getId(), DriveFolderID: folderIds.generatedFolderId,
        StorageProvider: 'GOOGLE_DRIVE_PRIVATE', IsMainFile: 'FALSE', IsPasswordProtectedSource: 'FALSE', ChecksumSHA256: sha256Base64_(bytes),
        UploadedByUserID: ctx.userId, UploadedAt: nowIso_(), Status: 'ACTIVE', Notes: String(input.notes || ''), CreatedAt: nowIso_(), CreatedBy: ctx.userId
    };
    file.setDescription('Generated PDF; DepartmentID=' + target.departmentId + '; AttachmentID=' + attachment.AttachmentID);
    appendObject_('Attachments', attachment);
    if (recordType === 'RECEIVE' && recordId)
        updateAttachmentCount_('ReceiveRegister', 'RecordID', recordId, 1);
    if (recordType === 'SEND' && recordId)
        updateAttachmentCount_('SendRegister', 'RecordID', recordId, 1);
    logAudit_({ departmentId: target.departmentId, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'GENERATE_PDF', module: 'reports', recordId: attachment.AttachmentID, description: 'สร้างและจัดเก็บ PDF ' + fileName });
    return safeRecord_(attachment);
}
function apiUploadImage_(input, ctx) {
    const key = PropertiesService.getScriptProperties().getProperty(PROP.IMGBB_API_KEY);
    if (!key)
        throw appError_('IMGBB_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่า IMGBB_API_KEY ใน Script Properties');
    const name = sanitizeFileName_(input.fileName || 'image'), mime = String(input.mimeType || 'image/jpeg'), base64 = String(input.fileBase64 || '');
    if (APP_CONFIG.IMAGE_MIME_TYPES.indexOf(mime) < 0)
        throw appError_('IMAGE_TYPE_NOT_ALLOWED', 'รองรับเฉพาะ JPG, PNG, WEBP และ GIF');
    if (!base64)
        throw appError_('IMAGE_DATA_REQUIRED', 'ไม่พบข้อมูลรูปภาพ');
    const bytes = decodeBase64_(base64);
    if (bytes.length > getMaxUploadBytes_())
        throw appError_('IMAGE_TOO_LARGE', 'รูปภาพมีขนาดเกินกำหนด');
    const ownerType = String(input.ownerType || ''), ownerId = String(input.ownerId || '');
    let imageDepartmentId = ctx.departmentId;
    if (ownerType === 'DEPARTMENT' && ownerId)
        imageDepartmentId = ownerId;
    // Validate the target before uploading and creating metadata.
    if (ownerType === 'DEPARTMENT' && ownerId)
        assertDepartmentAccess_(ctx, ownerId);
    if (ownerType === 'USER' && ownerId) {
        const owner = findObjectById_('Users', 'UserID', ownerId, false);
        if (!owner)
            throw appError_('USER_NOT_FOUND', 'ไม่พบผู้ใช้');
        assertDepartmentAccess_(ctx, owner.DepartmentID);
        imageDepartmentId = owner.DepartmentID;
    }
    if (ownerType !== '' && !['DEPARTMENT', 'USER'].includes(ownerType))
        throw appError_('INVALID_IMAGE_OWNER', 'ประเภทเจ้าของรูปภาพไม่ถูกต้อง');
    const response = UrlFetchApp.fetch('https://api.imgbb.com/1/upload?key=' + encodeURIComponent(key), { method: 'post', payload: { image: Utilities.base64Encode(bytes), name: name }, muteHttpExceptions: true });
    let result;
    try {
        result = JSON.parse(response.getContentText());
    }
    catch (error) {
        throw appError_('IMGBB_BAD_RESPONSE', 'ImgBB ส่งผลตอบกลับไม่ถูกต้อง');
    }
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300 || !result || !result.success || !result.data || !result.data.url)
        throw appError_('IMGBB_UPLOAD_FAILED', 'อัปโหลดรูปภาพไปยัง ImgBB ไม่สำเร็จ');
    const image = {
        ImageID: newId_('IMG'), DepartmentID: imageDepartmentId, OwnerType: ownerType, OwnerID: ownerId, ImageCategory: String(input.imageCategory || 'GENERAL'),
        OriginalFileName: name, MimeType: mime, FileSizeBytes: bytes.length, ImageURL: String(result.data.url), DeleteURL: String(result.data.delete_url || ''),
        UploadedByUserID: ctx.userId, UploadedAt: nowIso_(), Status: 'ACTIVE', Notes: String(input.notes || '')
    };
    appendObject_('ImageAssets', image);
    if (ownerType === 'DEPARTMENT' && ownerId)
        updateObjectById_('Departments', 'DepartmentID', ownerId, { LogoURL: image.ImageURL, LogoDeleteURL: image.DeleteURL, UpdatedAt: nowIso_(), UpdatedBy: ctx.userId });
    if (ownerType === 'USER' && ownerId)
        updateObjectById_('Users', 'UserID', ownerId, { AvatarURL: image.ImageURL, UpdatedAt: nowIso_(), UpdatedBy: ctx.userId });
    logAudit_({ departmentId: imageDepartmentId, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'UPLOAD_IMAGE', module: 'images', recordId: image.ImageID, description: 'อัปโหลดรูปภาพไปยัง ImgBB' });
    return safeRecord_(image);
}
/* ========================================================================== */
/*  14. WORKFLOW - FORWARD, ACKNOWLEDGE, APPROVE AND REJECT                   */
/* ========================================================================== */
function apiListWorkflow_(input, ctx) {
    const rows = findObjects_('Workflow', function (r) {
        if (r.DepartmentID !== ctx.departmentId && ctx.roleCode !== 'SUPER_ADMIN')
            return false;
        if (ctx.roleCode === 'SUPER_ADMIN' && input.departmentId && r.DepartmentID !== String(input.departmentId))
            return false;
        if (input.recordId && r.RecordID !== String(input.recordId))
            return false;
        if (input.recordType && r.RecordType !== normalizeRecordType_(input.recordType))
            return false;
        if (input.userId && r.ToUserID !== String(input.userId) && r.FromUserID !== String(input.userId))
            return false;
        if (input.status && r.Status !== String(input.status))
            return false;
        return true;
    }, true);
    rows.sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); });
    return paginate_(rows.map(safeRecord_), input);
}
function apiWorkflowForward_(input, ctx) {
    const record = assertWorkflowRecordAccess_(input, ctx);
    const targetUserId = String(input.toUserId || ''), targetDepartmentId = String(input.toDepartmentId || record.DepartmentID);
    if (!targetUserId && !targetDepartmentId)
        throw appError_('WORKFLOW_TARGET_REQUIRED', 'กรุณาระบุผู้รับหรือหน่วยงานปลายทาง');
    if (targetDepartmentId !== record.DepartmentID)
        throw appError_('CROSS_DEPARTMENT_WORKFLOW_UNSUPPORTED', 'Workflow ภายในระบบนี้แยกข้อมูลตามหน่วยงาน กรุณาใช้ทะเบียนหนังสือส่งเมื่อต้องส่งถึงหน่วยงานอื่น');
    if (targetDepartmentId !== ctx.departmentId && !findObjectById_('Departments', 'DepartmentID', targetDepartmentId, false))
        throw appError_('TARGET_DEPARTMENT_NOT_FOUND', 'ไม่พบหน่วยงานปลายทาง');
    let targetUser = null;
    if (targetUserId) {
        targetUser = findObjectById_('Users', 'UserID', targetUserId, false);
        if (!targetUser || targetUser.Status !== 'ACTIVE' || targetUser.DepartmentID !== targetDepartmentId)
            throw appError_('TARGET_USER_NOT_FOUND', 'ไม่พบผู้รับ หรือผู้รับไม่ได้อยู่ในหน่วยงานปลายทาง');
    }
    const nextStep = findObjects_('Workflow', function (r) { return r.DepartmentID === record.DepartmentID && r.RecordID === record.RecordID && r.RecordType === record.RecordType; }, true)
        .reduce(function (max, r) { return Math.max(max, Number(r.StepNo || 0)); }, 0) + 1;
    const workflow = createWorkflowEntry_({
        departmentId: record.DepartmentID, recordId: record.RecordID, recordType: record.RecordType, documentId: record.DocumentID || '',
        stepNo: nextStep, actionType: 'FORWARD', fromUserId: ctx.userId, toUserId: targetUserId,
        fromDepartmentId: record.DepartmentID, toDepartmentId: targetDepartmentId,
        actionNote: String(input.actionNote || ''), instruction: String(input.instruction || ''), status: 'PENDING', createdBy: ctx.userId
    });
    if (targetUser)
        createNotification_({ departmentId: targetDepartmentId, userId: targetUser.UserID, type: 'WORKFLOW', title: 'มีหนังสือส่งถึงคุณ', message: String(record.Subject || record.Title || 'มีรายการหนังสือส่งต่อ'), linkType: record.RecordType, linkId: record.RecordID, createdBy: ctx.userId });
    else
        createDepartmentNotifications_(targetDepartmentId, 'WORKFLOW', 'มีหนังสือส่งถึงหน่วยงาน', String(record.Subject || record.Title || 'มีรายการหนังสือส่งต่อ'), record.RecordType, record.RecordID, ctx.userId);
    logAudit_({ departmentId: record.DepartmentID, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'FORWARD', module: 'workflow', recordId: record.RecordID, recordType: record.RecordType, description: 'ส่งต่อหนังสือ' });
    return safeRecord_(workflow);
}
function apiWorkflowApprove_(input, ctx) { return processWorkflowDecision_(input, ctx, 'APPROVED', 'APPROVE'); }
function apiWorkflowReject_(input, ctx) { return processWorkflowDecision_(input, ctx, 'REJECTED', 'REJECT'); }
function apiWorkflowAcknowledge_(input, ctx) {
    const workflow = findObjectById_('Workflow', 'WorkflowID', String(input.workflowId || ''), true);
    if (!workflow || workflow.Status !== 'PENDING')
        throw appError_('WORKFLOW_NOT_PENDING', 'ไม่พบรายการส่งต่อที่รอรับทราบ');
    assertDepartmentAccess_(ctx, workflow.DepartmentID);
    if (workflow.ToUserID && workflow.ToUserID !== ctx.userId && !['SUPER_ADMIN', 'DEPT_ADMIN'].includes(ctx.roleCode))
        throw appError_('WORKFLOW_RECIPIENT_ONLY', 'รายการนี้ส่งถึงผู้ใช้อื่น');
    if (workflow.ToDepartmentID && workflow.ToDepartmentID !== ctx.departmentId && ctx.roleCode !== 'SUPER_ADMIN')
        throw appError_('WORKFLOW_DEPARTMENT_ONLY', 'รายการนี้ส่งถึงหน่วยงานอื่น');
    const updated = updateObjectById_('Workflow', 'WorkflowID', workflow.WorkflowID, { Status: 'ACKNOWLEDGED', ReceivedAt: nowIso_(), UpdatedAt: nowIso_(), UpdatedBy: ctx.userId, ActionNote: appendNote_(workflow.ActionNote, input.actionNote) });
    if (workflow.FromUserID)
        createNotification_({ departmentId: workflow.DepartmentID, userId: workflow.FromUserID, type: 'WORKFLOW', title: 'หนังสือได้รับการรับทราบแล้ว', message: 'ผู้รับรับทราบหนังสือที่ส่งต่อแล้ว', linkType: workflow.RecordType, linkId: workflow.RecordID, createdBy: ctx.userId });
    logAudit_({ departmentId: workflow.DepartmentID, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'ACKNOWLEDGE', module: 'workflow', recordId: workflow.WorkflowID, description: 'รับทราบหนังสือที่ส่งต่อ' });
    return safeRecord_(updated);
}
function processWorkflowDecision_(input, ctx, status, action) {
    const workflow = findObjectById_('Workflow', 'WorkflowID', String(input.workflowId || ''), true);
    if (!workflow || !['PENDING', 'ACKNOWLEDGED'].includes(workflow.Status))
        throw appError_('WORKFLOW_NOT_ACTIONABLE', 'รายการนี้ไม่อยู่ในสถานะที่ดำเนินการได้');
    assertDepartmentAccess_(ctx, workflow.DepartmentID);
    if (workflow.ToUserID && workflow.ToUserID !== ctx.userId && !['SUPER_ADMIN', 'DEPT_ADMIN'].includes(ctx.roleCode))
        throw appError_('WORKFLOW_RECIPIENT_ONLY', 'เฉพาะผู้รับหรือผู้ดูแลหน่วยงานเท่านั้นที่ดำเนินการได้');
    const updated = updateObjectById_('Workflow', 'WorkflowID', workflow.WorkflowID, { Status: status, CompletedAt: nowIso_(), UpdatedAt: nowIso_(), UpdatedBy: ctx.userId, ActionNote: appendNote_(workflow.ActionNote, input.actionNote) });
    if (workflow.FromUserID)
        createNotification_({ departmentId: workflow.DepartmentID, userId: workflow.FromUserID, type: 'WORKFLOW', title: status === 'APPROVED' ? 'หนังสือได้รับการอนุมัติ' : 'หนังสือถูกส่งกลับ', message: String(input.actionNote || (status === 'APPROVED' ? 'รายการได้รับการอนุมัติ' : 'รายการถูกปฏิเสธ')), linkType: workflow.RecordType, linkId: workflow.RecordID, createdBy: ctx.userId });
    logAudit_({ departmentId: workflow.DepartmentID, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: action, module: 'workflow', recordId: workflow.WorkflowID, description: (status === 'APPROVED' ? 'อนุมัติ' : 'ปฏิเสธ') + ' รายการส่งต่อ' });
    return safeRecord_(updated);
}
function assertWorkflowRecordAccess_(input, ctx) {
    const type = normalizeRecordType_(input.recordType), id = String(input.recordId || '');
    if (!id)
        throw appError_('RECORD_ID_REQUIRED', 'กรุณาระบุรหัสรายการ');
    const map = { RECEIVE: 'ReceiveRegister', SEND: 'SendRegister', DOCUMENT: 'Documents' };
    const sheet = map[type];
    if (!sheet)
        throw appError_('INVALID_RECORD_TYPE', 'ประเภทรายการไม่ถูกต้อง');
    const field = type === 'DOCUMENT' ? 'DocumentID' : 'RecordID', record = findObjectById_(sheet, field, id, false);
    if (!record)
        throw appError_('RECORD_NOT_FOUND', 'ไม่พบรายการหนังสือ');
    assertDepartmentAccess_(ctx, record.DepartmentID);
    return Object.assign({ RecordType: type, RecordID: id }, record);
}
function createWorkflowEntry_(data) {
    const item = { WorkflowID: newId_('WFL'), DepartmentID: data.departmentId, RecordID: data.recordId, RecordType: data.recordType,
        DocumentID: data.documentId || '', StepNo: Number(data.stepNo || 1), ActionType: data.actionType, FromUserID: data.fromUserId || '',
        ToUserID: data.toUserId || '', FromDepartmentID: data.fromDepartmentId || '', ToDepartmentID: data.toDepartmentId || '',
        ActionNote: data.actionNote || '', Instruction: data.instruction || '', Status: data.status || 'PENDING', SentAt: nowIso_(),
        ReceivedAt: '', CompletedAt: '', SignatureText: '', CreatedAt: nowIso_(), CreatedBy: data.createdBy || 'SYSTEM', UpdatedAt: nowIso_(), UpdatedBy: data.createdBy || 'SYSTEM' };
    appendObject_('Workflow', item);
    return item;
}
/* ========================================================================== */
/*  15. ASSIGNMENTS AND TASK TRACKING                                         */
/* ========================================================================== */
function apiListAssignments_(input, ctx) {
    const rows = findObjects_('Assignments', function (r) {
        if (r.DepartmentID !== ctx.departmentId && ctx.roleCode !== 'SUPER_ADMIN')
            return false;
        if (ctx.roleCode === 'SUPER_ADMIN' && input.departmentId && r.DepartmentID !== String(input.departmentId))
            return false;
        if (input.status && r.Status !== String(input.status))
            return false;
        if (input.assignedToUserId && r.AssignedToUserID !== String(input.assignedToUserId))
            return false;
        if (isTrue_(input.mine) && r.AssignedToUserID !== ctx.userId && r.AssignedByUserID !== ctx.userId)
            return false;
        if (ctx.roleCode === 'STAFF' && !isTrue_(input.showDepartmentWide) && r.AssignedToUserID !== ctx.userId && r.AssignedByUserID !== ctx.userId)
            return false;
        return true;
    });
    rows.sort(function (a, b) { return String(a.DueDate || '9999').localeCompare(String(b.DueDate || '9999')); });
    return paginate_(rows.map(safeRecord_), input);
}
function apiCreateAssignment_(input, ctx) {
    const record = assertWorkflowRecordAccess_({ recordType: input.recordType, recordId: input.recordId }, ctx);
    const targetId = String(input.assignedToUserId || '');
    const target = findObjectById_('Users', 'UserID', targetId, false);
    if (!target || target.DepartmentID !== record.DepartmentID || target.Status !== 'ACTIVE')
        throw appError_('ASSIGNEE_NOT_FOUND', 'ไม่พบผู้รับมอบหมายที่ใช้งานได้ในหน่วยงานของหนังสือ');
    const title = String(input.taskTitle || record.Subject || record.Title || '').trim();
    if (!title)
        throw appError_('TASK_TITLE_REQUIRED', 'กรุณาระบุชื่องาน');
    const dueDate = normalizeDateInput_(input.dueDate, false);
    const task = { AssignmentID: newId_('TSK'), DepartmentID: record.DepartmentID, RecordID: record.RecordID, RecordType: record.RecordType, DocumentID: record.DocumentID || '',
        TaskTitle: title, Description: String(input.description || ''), AssignedByUserID: ctx.userId, AssignedToUserID: target.UserID,
        AssignedDepartmentID: record.DepartmentID, DueDate: dueDate, Priority: normalizePriority_(input.priority), Status: 'PENDING', ProgressPercent: 0,
        StartedAt: '', CompletedAt: '', ResultText: '', CreatedAt: nowIso_(), CreatedBy: ctx.userId, UpdatedAt: nowIso_(), UpdatedBy: ctx.userId, DeletedAt: '', DeletedBy: '' };
    appendObject_('Assignments', task);
    createNotification_({ departmentId: record.DepartmentID, userId: target.UserID, type: 'ASSIGNMENT', title: 'คุณได้รับมอบหมายงาน', message: title, linkType: 'ASSIGNMENT', linkId: task.AssignmentID, createdBy: ctx.userId });
    logAudit_({ departmentId: record.DepartmentID, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'CREATE', module: 'assignments', recordId: task.AssignmentID, description: 'มอบหมายงาน ' + title });
    return safeRecord_(task);
}
function apiUpdateAssignment_(input, ctx) {
    const id = String(input.assignmentId || ''), task = findObjectById_('Assignments', 'AssignmentID', id, false);
    if (!task)
        throw appError_('TASK_NOT_FOUND', 'ไม่พบงานที่ต้องการแก้ไข');
    assertDepartmentAccess_(ctx, task.DepartmentID);
    const isOwner = task.AssignedToUserID === ctx.userId, isCreator = task.AssignedByUserID === ctx.userId;
    if (!isOwner && !isCreator && !['SUPER_ADMIN', 'DEPT_ADMIN', 'DEPT_HEAD'].includes(ctx.roleCode))
        throw appError_('TASK_ACCESS_DENIED', 'ไม่มีสิทธิ์แก้ไขงานนี้');
    const patch = { UpdatedAt: nowIso_(), UpdatedBy: ctx.userId };
    if (input.taskTitle !== undefined && (isCreator || ['SUPER_ADMIN', 'DEPT_ADMIN'].includes(ctx.roleCode)))
        patch.TaskTitle = String(input.taskTitle).trim();
    if (input.description !== undefined && (isCreator || ['SUPER_ADMIN', 'DEPT_ADMIN'].includes(ctx.roleCode)))
        patch.Description = String(input.description);
    if (input.dueDate !== undefined && (isCreator || ['SUPER_ADMIN', 'DEPT_ADMIN'].includes(ctx.roleCode)))
        patch.DueDate = normalizeDateInput_(input.dueDate, false);
    if (input.priority !== undefined && (isCreator || ['SUPER_ADMIN', 'DEPT_ADMIN'].includes(ctx.roleCode)))
        patch.Priority = normalizePriority_(input.priority);
    if (input.progressPercent !== undefined)
        patch.ProgressPercent = clampNumber_(input.progressPercent, 0, 100, 0);
    if (input.status !== undefined) {
        const status = String(input.status).toUpperCase();
        if (!['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'ON_HOLD'].includes(status))
            throw appError_('INVALID_TASK_STATUS', 'สถานะงานไม่ถูกต้อง');
        if (!isCreator && !['SUPER_ADMIN', 'DEPT_ADMIN', 'DEPT_HEAD'].includes(ctx.roleCode) && status === 'CANCELLED')
            throw appError_('TASK_CANCEL_DENIED', 'ผู้รับมอบหมายไม่สามารถยกเลิกงานได้');
        patch.Status = status;
        if (status === 'IN_PROGRESS' && !task.StartedAt)
            patch.StartedAt = nowIso_();
        if (status === 'COMPLETED') {
            patch.CompletedAt = nowIso_();
            patch.ProgressPercent = 100;
        }
    }
    if (input.resultText !== undefined)
        patch.ResultText = String(input.resultText);
    const updated = updateObjectById_('Assignments', 'AssignmentID', id, patch);
    if (task.AssignedByUserID && task.AssignedByUserID !== ctx.userId)
        createNotification_({ departmentId: task.DepartmentID, userId: task.AssignedByUserID, type: 'ASSIGNMENT', title: 'มีการอัปเดตงานที่มอบหมาย', message: task.TaskTitle, linkType: 'ASSIGNMENT', linkId: id, createdBy: ctx.userId });
    logAudit_({ departmentId: task.DepartmentID, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'UPDATE', module: 'assignments', recordId: id, description: 'ปรับปรุงงานที่ได้รับมอบหมาย' });
    return safeRecord_(updated);
}
function apiCompleteAssignment_(input, ctx) {
    return apiUpdateAssignment_(Object.assign({}, input, { status: 'COMPLETED', progressPercent: 100 }), ctx);
}
/* ========================================================================== */
/*  16. NOTIFICATIONS                                                         */
/* ========================================================================== */
function apiListNotifications_(input, ctx) {
    const rows = findObjects_('Notifications', function (r) {
        if (r.DepartmentID !== ctx.departmentId && ctx.roleCode !== 'SUPER_ADMIN')
            return false;
        if (ctx.roleCode === 'SUPER_ADMIN' && input.departmentId && r.DepartmentID !== String(input.departmentId))
            return false;
        if (ctx.roleCode !== 'SUPER_ADMIN' && r.UserID && r.UserID !== ctx.userId)
            return false;
        if (isTrue_(input.unreadOnly) && isTrue_(r.IsRead))
            return false;
        return !r.ExpiresAt || new Date(r.ExpiresAt).getTime() > Date.now();
    }, true).sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); });
    return { unreadCount: rows.filter(function (r) { return !isTrue_(r.IsRead); }).length, items: paginate_(rows.map(safeRecord_), input) };
}
function apiMarkNotificationRead_(input, ctx) {
    const item = findObjectById_('Notifications', 'NotificationID', String(input.notificationId || ''), true);
    if (!item)
        throw appError_('NOTIFICATION_NOT_FOUND', 'ไม่พบการแจ้งเตือน');
    assertDepartmentAccess_(ctx, item.DepartmentID);
    if (item.UserID && item.UserID !== ctx.userId && !['SUPER_ADMIN', 'DEPT_ADMIN'].includes(ctx.roleCode))
        throw appError_('NOTIFICATION_ACCESS_DENIED', 'ไม่มีสิทธิ์อ่านการแจ้งเตือนนี้');
    return safeRecord_(updateObjectById_('Notifications', 'NotificationID', item.NotificationID, { IsRead: 'TRUE', ReadAt: nowIso_() }));
}
function apiMarkAllNotificationsRead_(input, ctx) {
    const rows = findObjects_('Notifications', function (r) { return r.DepartmentID === ctx.departmentId && (!r.UserID || r.UserID === ctx.userId) && !isTrue_(r.IsRead); }, true);
    rows.forEach(function (r) { updateObjectById_('Notifications', 'NotificationID', r.NotificationID, { IsRead: 'TRUE', ReadAt: nowIso_() }); });
    return { marked: rows.length };
}
function createNotification_(data) {
    const notification = { NotificationID: newId_('NTF'), DepartmentID: data.departmentId, UserID: data.userId || '', Type: data.type || 'INFO', Title: String(data.title || 'แจ้งเตือน'), Message: String(data.message || ''), LinkType: String(data.linkType || ''), LinkID: String(data.linkId || ''), IsRead: 'FALSE', ReadAt: '', CreatedAt: nowIso_(), CreatedBy: data.createdBy || 'SYSTEM', ExpiresAt: data.expiresAt || '' };
    appendObject_('Notifications', notification);
    return notification;
}
function createDepartmentNotifications_(departmentId, type, title, message, linkType, linkId, createdBy) {
    const users = findObjects_('Users', function (u) { return u.DepartmentID === departmentId && u.Status === 'ACTIVE'; });
    users.forEach(function (u) { createNotification_({ departmentId: departmentId, userId: u.UserID, type: type, title: title, message: message, linkType: linkType, linkId: linkId, createdBy: createdBy }); });
}
/* ========================================================================== */
/*  17. GLOBAL SEARCH AND REPORTING                                            */
/* ========================================================================== */
function apiSearchAll_(input, ctx) {
    const query = String(input.query || '').trim().toLowerCase();
    if (query.length < 2)
        throw appError_('SEARCH_QUERY_TOO_SHORT', 'กรุณาระบุคำค้นหาอย่างน้อย 2 ตัวอักษร');
    const limit = Math.min(Math.max(Number(input.limit || 50), 1), 100), results = [];
    const sources = [
        { sheet: 'ReceiveRegister', type: 'RECEIVE', id: 'RecordID', title: 'Subject', fields: ['RegisterNo', 'BookNo', 'Subject', 'FromOrganization', 'Keywords', 'SearchText'] },
        { sheet: 'SendRegister', type: 'SEND', id: 'RecordID', title: 'Subject', fields: ['RegisterNo', 'BookNo', 'Subject', 'ToOrganization', 'Keywords', 'SearchText'] },
        { sheet: 'Documents', type: 'DOCUMENT', id: 'DocumentID', title: 'Title', fields: ['DocumentCode', 'Title', 'Subject', 'BookNo', 'FromOrganization', 'ToOrganization', 'Keywords', 'SearchText'] }
    ];
    sources.forEach(function (source) {
        findObjects_(source.sheet, function (r) {
            if (r.DepartmentID !== ctx.departmentId && ctx.roleCode !== 'SUPER_ADMIN')
                return false;
            if (ctx.roleCode === 'SUPER_ADMIN' && input.departmentId && r.DepartmentID !== String(input.departmentId))
                return false;
            return source.fields.some(function (field) { return String(r[field] || '').toLowerCase().indexOf(query) >= 0; });
        }).forEach(function (record) {
            results.push({ recordType: source.type, recordId: record[source.id], title: record[source.title] || '', registerNo: record.RegisterNo || '', bookNo: record.BookNo || '', date: record.ReceiveDate || record.SendDate || record.BookDate || '', status: record.Status || '', departmentId: record.DepartmentID });
        });
    });
    results.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    return { query: query, total: results.length, items: results.slice(0, limit) };
}
function apiGetReport_(input, ctx) {
    const reportType = String(input.reportType || 'RECEIVE_REGISTER').toUpperCase();
    const from = normalizeDateInput_(input.fromDate, false), to = normalizeDateInput_(input.toDate, false);
    const inRange = function (value) { const date = String(value || '').substring(0, 10); return (!from || date >= from) && (!to || date <= to); };
    const reportDepartment = ctx.roleCode === 'SUPER_ADMIN' && input.departmentId ? String(input.departmentId) : '';
    const withinDepartment = function (r) { return ctx.roleCode === 'SUPER_ADMIN' ? (!reportDepartment || r.DepartmentID === reportDepartment) : r.DepartmentID === ctx.departmentId; };
    const receive = findObjects_('ReceiveRegister', function (r) { return withinDepartment(r) && inRange(r.ReceiveDate); });
    const send = findObjects_('SendRegister', function (r) { return withinDepartment(r) && inRange(r.SendDate); });
    let records = [], summary = {};
    if (reportType === 'RECEIVE_REGISTER')
        records = receive;
    else if (reportType === 'SEND_REGISTER')
        records = send;
    else if (reportType === 'PENDING')
        records = receive.concat(send).filter(function (r) { return ['PENDING', 'IN_PROGRESS', 'WAITING_APPROVAL', 'DRAFT'].indexOf(String(r.Status)) >= 0; });
    else if (reportType === 'OVERDUE')
        records = receive.concat(send).filter(function (r) { return r.DueDate && String(r.DueDate) < today_() && !['COMPLETED', 'CANCELLED', 'DISPATCHED', 'DELIVERED'].includes(String(r.Status)); });
    else if (reportType === 'BY_TYPE') {
        const all = receive.concat(send), map = {};
        all.forEach(function (r) { const key = String(r.DocumentType || 'ไม่ระบุ'); map[key] = (map[key] || 0) + 1; });
        summary = Object.keys(map).sort().map(function (key) { return { documentType: key, count: map[key] }; });
    }
    else if (reportType === 'BY_STATUS') {
        const all = receive.concat(send), map = {};
        all.forEach(function (r) { const key = String(r.Status || 'ไม่ระบุ'); map[key] = (map[key] || 0) + 1; });
        summary = Object.keys(map).sort().map(function (key) { return { status: key, count: map[key] }; });
    }
    else if (reportType === 'MONTHLY') {
        const map = {};
        receive.forEach(function (r) { const key = String(r.ReceiveDate || '').substring(0, 7); if (key)
            map[key] = map[key] || { month: key, received: 0, sent: 0 }; map[key].received++; });
        send.forEach(function (r) { const key = String(r.SendDate || '').substring(0, 7); if (key)
            map[key] = map[key] || { month: key, received: 0, sent: 0 }; map[key].sent++; });
        summary = Object.keys(map).sort().map(function (key) { return map[key]; });
    }
    else
        throw appError_('UNKNOWN_REPORT', 'ไม่รู้จักประเภทรายงานที่ร้องขอ');
    records.sort(function (a, b) { return String(a.RegisterNo || '').localeCompare(String(b.RegisterNo || ''), undefined, { numeric: true }); });
    return { reportType: reportType, fromDate: from, toDate: to, total: records.length, summary: summary, items: paginate_(records.map(safeRecord_), input) };
}
function apiLogReportExport_(input, ctx) {
    const details = { departmentId: ctx.departmentId, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'EXPORT', module: 'reports', recordId: String(input.reportType || ''), description: 'ส่งออกรายงาน ' + String(input.reportType || '') + ' เป็น ' + String(input.format || 'PDF') };
    logAudit_(details);
    return { logged: true };
}
function apiDashboardSummary_(input, ctx) {
    const selectedDepartment = ctx.roleCode === 'SUPER_ADMIN' && input.departmentId ? String(input.departmentId) : '';
    if (selectedDepartment) {
        assertDepartmentAccess_(ctx, selectedDepartment);
        const dept = findObjectById_('Departments', 'DepartmentID', selectedDepartment, false);
        if (!dept || dept.Status !== 'ACTIVE')
            throw appError_('DEPARTMENT_NOT_FOUND', 'ไม่พบหน่วยงานที่ใช้งานได้');
    }
    const deptFilter = function (r) { return ctx.roleCode === 'SUPER_ADMIN' ? (!selectedDepartment || r.DepartmentID === selectedDepartment) : r.DepartmentID === ctx.departmentId; };
    const receive = findObjects_('ReceiveRegister', deptFilter), send = findObjects_('SendRegister', deptFilter), assignments = findObjects_('Assignments', deptFilter), users = findObjects_('Users', function (r) { return deptFilter(r) && r.Status === 'ACTIVE'; });
    const notifications = findObjects_('Notifications', function (r) { return deptFilter(r) && (!r.UserID || r.UserID === ctx.userId) && !isTrue_(r.IsRead); });
    const pending = receive.concat(send).filter(function (r) { return !['COMPLETED', 'CANCELLED', 'DISPATCHED', 'DELIVERED'].includes(String(r.Status)); });
    const overdue = receive.concat(send).filter(function (r) { return r.DueDate && String(r.DueDate) < today_() && !['COMPLETED', 'CANCELLED', 'DISPATCHED', 'DELIVERED'].includes(String(r.Status)); });
    const byMonth = {}, currentYear = String(new Date().getFullYear());
    receive.forEach(function (r) { const d = String(r.ReceiveDate || ''); if (d.indexOf(currentYear) === 0) {
        const k = d.substring(0, 7);
        byMonth[k] = byMonth[k] || { month: k, received: 0, sent: 0 };
        byMonth[k].received++;
    } });
    send.forEach(function (r) { const d = String(r.SendDate || ''); if (d.indexOf(currentYear) === 0) {
        const k = d.substring(0, 7);
        byMonth[k] = byMonth[k] || { month: k, received: 0, sent: 0 };
        byMonth[k].sent++;
    } });
    const recent = receive.concat(send).sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); }).slice(0, 10).map(function (r) { return { recordId: r.RecordID, recordType: r.RegisterNo && r.ReceiveDate ? 'RECEIVE' : 'SEND', registerNo: r.RegisterNo, subject: r.Subject, date: r.ReceiveDate || r.SendDate, status: r.Status }; });
    const scope = { departmentId: selectedDepartment || (ctx.roleCode === 'SUPER_ADMIN' ? 'ALL' : ctx.departmentId), departmentCount: ctx.roleCode === 'SUPER_ADMIN' && !selectedDepartment ? findObjects_('Departments', function (r) { return r.Status === 'ACTIVE'; }).length : 1, userCount: users.length, receiveCount: receive.length, sendCount: send.length, pendingCount: pending.length, overdueCount: overdue.length, assignmentCount: assignments.length, unreadNotificationCount: notifications.length };
    return { scope: scope, monthly: Object.keys(byMonth).sort().map(function (k) { return byMonth[k]; }), recent: recent, generatedAt: nowIso_() };
}
/* ========================================================================== */
/*  18. SETTINGS AND CATEGORIES                                               */
/* ========================================================================== */
function apiListSettings_(input, ctx) {
    const rows = findObjects_('Settings', function (r) {
        const requestedDepartment = ctx.roleCode === 'SUPER_ADMIN' && input.departmentId ? String(input.departmentId) : ctx.departmentId;
        if (r.DepartmentID !== requestedDepartment && r.DepartmentID !== APP_CONFIG.SYSTEM_DEPARTMENT_ID)
            return false;
        if (isTrue_(input.publicOnly) && !isTrue_(r.IsPublic))
            return false;
        return true;
    }, true);
    const result = {};
    rows.forEach(function (r) { result[r.SettingKey] = r.SettingValue; });
    return { items: rows.map(safeRecord_), values: result };
}
function apiSaveSettings_(input, ctx) {
    const values = Array.isArray(input.settings) ? input.settings : [];
    if (!values.length)
        throw appError_('SETTINGS_REQUIRED', 'ไม่มีรายการตั้งค่าที่ต้องการบันทึก');
    const saved = [];
    values.forEach(function (item) {
        const key = String(item.key || '').trim().toUpperCase();
        if (!/^[A-Z0-9_.-]{2,80}$/.test(key))
            throw appError_('INVALID_SETTING_KEY', 'ชื่อการตั้งค่าไม่ถูกต้อง');
        const isSystem = ctx.roleCode === 'SUPER_ADMIN' && isTrue_(item.global);
        const departmentId = isSystem ? APP_CONFIG.SYSTEM_DEPARTMENT_ID : (ctx.roleCode === 'SUPER_ADMIN' && item.departmentId ? String(item.departmentId) : ctx.departmentId);
        if (departmentId !== APP_CONFIG.SYSTEM_DEPARTMENT_ID)
            assertDepartmentAccess_(ctx, departmentId);
        if (key === 'PASSWORD_DOWNLOAD_ENABLED' && (item.value === false || String(item.value).toLowerCase() === 'false' || String(item.value) === '0'))
            throw appError_('PASSWORD_PROTECTION_REQUIRED', 'ระบบกำหนดให้ไฟล์ดาวน์โหลดต้องมีรหัสผ่านเสมอ');
        const value = normalizeSettingValue_(item.value, item.dataType || 'STRING');
        const old = findObjects_('Settings', function (r) { return r.DepartmentID === departmentId && r.SettingKey === key; }, true)[0];
        const data = { SettingID: old ? old.SettingID : newId_('SET'), DepartmentID: departmentId, SettingKey: key, SettingValue: value, DataType: String(item.dataType || (old && old.DataType) || 'STRING').toUpperCase(), Description: String(item.description || (old && old.Description) || ''), IsPublic: isTrue_(item.isPublic) ? 'TRUE' : 'FALSE', UpdatedAt: nowIso_(), UpdatedBy: ctx.userId };
        if (old)
            updateObjectById_('Settings', 'SettingID', old.SettingID, data);
        else {
            appendObject_('Settings', Object.assign({ CreatedAt: nowIso_(), CreatedBy: ctx.userId }, data));
        }
        saved.push({ key: key, departmentId: departmentId });
    });
    logAudit_({ departmentId: ctx.departmentId, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'SAVE', module: 'settings', description: 'บันทึกการตั้งค่า ' + saved.length + ' รายการ' });
    return { saved: saved };
}
function apiListCategories_(input, ctx) {
    const rows = findObjects_('Categories', function (r) {
        const requestedDepartment = ctx.roleCode === 'SUPER_ADMIN' && input.departmentId ? String(input.departmentId) : ctx.departmentId;
        return (r.DepartmentID === requestedDepartment || r.DepartmentID === APP_CONFIG.SYSTEM_DEPARTMENT_ID) && (!input.categoryType || r.CategoryType === String(input.categoryType)) && (isTrue_(input.includeInactive) || isTrue_(r.IsActive));
    }, true).sort(function (a, b) { return Number(a.SortOrder || 0) - Number(b.SortOrder || 0); });
    return paginate_(rows.map(safeRecord_), input);
}
function apiCreateCategory_(input, ctx) {
    const type = String(input.categoryType || '').trim().toUpperCase(), code = String(input.categoryCode || '').trim().toUpperCase(), name = String(input.categoryName || '').trim();
    if (!type || !code || !name)
        throw appError_('CATEGORY_FIELDS_REQUIRED', 'กรุณาระบุประเภท รหัส และชื่อหมวดหมู่');
    const targetDepartment = ctx.roleCode === 'SUPER_ADMIN' && input.departmentId ? String(input.departmentId) : ctx.departmentId;
    assertDepartmentAccess_(ctx, targetDepartment);
    if (findObjects_('Categories', function (r) { return r.DepartmentID === targetDepartment && r.CategoryType === type && r.CategoryCode === code; }, true)[0])
        throw appError_('CATEGORY_EXISTS', 'รหัสหมวดหมู่นี้มีอยู่แล้ว');
    const item = { CategoryID: newId_('CAT'), DepartmentID: targetDepartment, CategoryType: type, CategoryCode: code, CategoryName: name, Description: String(input.description || ''), SortOrder: clampNumber_(input.sortOrder, 0, 100000, 0), IsActive: 'TRUE', IsSystem: 'FALSE', CreatedAt: nowIso_(), CreatedBy: ctx.userId, UpdatedAt: nowIso_(), UpdatedBy: ctx.userId };
    appendObject_('Categories', item);
    return safeRecord_(item);
}
function apiUpdateCategory_(input, ctx) {
    const id = String(input.categoryId || ''), item = findObjectById_('Categories', 'CategoryID', id, true);
    if (!item)
        throw appError_('CATEGORY_NOT_FOUND', 'ไม่พบหมวดหมู่');
    if (item.DepartmentID !== ctx.departmentId && ctx.roleCode !== 'SUPER_ADMIN')
        throw appError_('PERMISSION_DENIED', 'ไม่มีสิทธิ์แก้ไขหมวดหมู่นี้');
    if (isTrue_(item.IsSystem) && ctx.roleCode !== 'SUPER_ADMIN')
        throw appError_('SYSTEM_CATEGORY_LOCKED', 'ไม่สามารถแก้ไขหมวดหมู่ระบบได้');
    const patch = { UpdatedAt: nowIso_(), UpdatedBy: ctx.userId };
    ['categoryName', 'description', 'sortOrder'].forEach(function (key) { if (input[key] !== undefined)
        patch[key === 'categoryName' ? 'CategoryName' : key === 'description' ? 'Description' : 'SortOrder'] = key === 'sortOrder' ? clampNumber_(input[key], 0, 100000, 0) : String(input[key]); });
    return safeRecord_(updateObjectById_('Categories', 'CategoryID', id, patch));
}
function apiDeactivateCategory_(input, ctx) {
    const item = findObjectById_('Categories', 'CategoryID', String(input.categoryId || ''), true);
    if (!item)
        throw appError_('CATEGORY_NOT_FOUND', 'ไม่พบหมวดหมู่');
    if (item.DepartmentID !== ctx.departmentId && ctx.roleCode !== 'SUPER_ADMIN')
        throw appError_('PERMISSION_DENIED', 'ไม่มีสิทธิ์จัดการหมวดหมู่นี้');
    if (isTrue_(item.IsSystem) && ctx.roleCode !== 'SUPER_ADMIN')
        throw appError_('SYSTEM_CATEGORY_LOCKED', 'ไม่สามารถปิดหมวดหมู่ระบบได้');
    return safeRecord_(updateObjectById_('Categories', 'CategoryID', item.CategoryID, { IsActive: 'FALSE', UpdatedAt: nowIso_(), UpdatedBy: ctx.userId }));
}
function normalizeSettingValue_(value, dataType) {
    const type = String(dataType || 'STRING').toUpperCase();
    if (type === 'BOOLEAN')
        return (value === true || String(value).toLowerCase() === 'true' || String(value) === '1') ? 'TRUE' : 'FALSE';
    if (type === 'NUMBER') {
        const n = Number(value);
        if (!isFinite(n))
            throw appError_('INVALID_SETTING_VALUE', 'ค่าการตั้งค่าต้องเป็นตัวเลข');
        return String(n);
    }
    if (type === 'JSON') {
        if (typeof value === 'string') {
            JSON.parse(value);
            return value;
        }
        return JSON.stringify(value);
    }
    return String(value == null ? '' : value);
}
function getSettingValue_(departmentId, key, fallback) {
    const row = findObjects_('Settings', function (r) { return r.DepartmentID === departmentId && r.SettingKey === key; }, true)[0] || findObjects_('Settings', function (r) { return r.DepartmentID === APP_CONFIG.SYSTEM_DEPARTMENT_ID && r.SettingKey === key; }, true)[0];
    return row ? row.SettingValue : fallback;
}
function getSettingBoolean_(departmentId, key, fallback) {
    const value = getSettingValue_(departmentId, key, fallback ? 'TRUE' : 'FALSE');
    return String(value).toLowerCase() === 'true' || String(value) === '1';
}
/* ========================================================================== */
/*  19. AUDIT HISTORY, DOWNLOAD HISTORY AND TRASH                             */
/* ========================================================================== */
function apiListAuditLogs_(input, ctx) {
    const rows = findObjects_('AuditLogs', function (r) {
        if (ctx.roleCode !== 'SUPER_ADMIN' && r.DepartmentID !== ctx.departmentId)
            return false;
        if (ctx.roleCode === 'SUPER_ADMIN' && input.departmentId && r.DepartmentID !== String(input.departmentId))
            return false;
        if (input.module && r.Module !== String(input.module))
            return false;
        if (input.action && r.Action !== String(input.action))
            return false;
        if (input.userId && r.UserID !== String(input.userId))
            return false;
        if (input.fromDate && String(r.CreatedAt) < String(input.fromDate))
            return false;
        if (input.toDate && String(r.CreatedAt).substring(0, 10) > String(input.toDate))
            return false;
        return true;
    }, true).sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); });
    return paginate_(rows.map(safeRecord_), input);
}
function apiListDownloadLogs_(input, ctx) {
    const rows = findObjects_('DownloadLogs', function (r) {
        if (ctx.roleCode !== 'SUPER_ADMIN' && r.DepartmentID !== ctx.departmentId)
            return false;
        if (ctx.roleCode === 'SUPER_ADMIN' && input.departmentId && r.DepartmentID !== String(input.departmentId))
            return false;
        if (input.userId && r.UserID !== String(input.userId))
            return false;
        if (input.passwordProtected !== undefined && isTrue_(r.PasswordProtected) !== isTrue_(input.passwordProtected))
            return false;
        if (input.fromDate && String(r.CreatedAt) < String(input.fromDate))
            return false;
        if (input.toDate && String(r.CreatedAt).substring(0, 10) > String(input.toDate))
            return false;
        return true;
    }, true).sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); });
    return paginate_(rows.map(safeRecord_), input);
}
function apiListTrash_(input, ctx) {
    const rows = findObjects_('Trash', function (r) {
        if (ctx.roleCode !== 'SUPER_ADMIN' && r.DepartmentID !== ctx.departmentId)
            return false;
        if (ctx.roleCode === 'SUPER_ADMIN' && input.departmentId && r.DepartmentID !== String(input.departmentId))
            return false;
        return !r.RestoreStatus || r.RestoreStatus === 'DELETED';
    }, true).sort(function (a, b) { return String(b.DeletedAt).localeCompare(String(a.DeletedAt)); });
    return paginate_(rows.map(function (r) { const clean = safeRecord_(r); delete clean.RecordJSON; return clean; }), input);
}
function moveRecordToTrash_(sheetName, idField, id, ctx, reason) {
    const record = findObjectById_(sheetName, idField, id, false);
    if (!record)
        throw appError_('RECORD_NOT_FOUND', 'ไม่พบรายการที่ต้องการลบ');
    assertDepartmentAccess_(ctx, record.DepartmentID);
    const trash = { TrashID: newId_('TRS'), DepartmentID: record.DepartmentID, SourceSheet: sheetName, SourceRecordID: id, RecordJSON: JSON.stringify(stripInternalFields_(record)), DeletedBy: ctx.userId, DeletedAt: nowIso_(), RestoreStatus: 'DELETED', RestoredAt: '', RestoredBy: '', Reason: String(reason || '') };
    appendObject_('Trash', trash);
    const patch = { DeletedAt: nowIso_(), DeletedBy: ctx.userId, UpdatedAt: nowIso_(), UpdatedBy: ctx.userId };
    if (sheetName === 'ReceiveRegister' || sheetName === 'SendRegister' || sheetName === 'Documents' || sheetName === 'Attachments')
        patch.Status = 'DELETED';
    updateObjectById_(sheetName, idField, id, patch);
    logAudit_({ departmentId: record.DepartmentID, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'MOVE_TO_TRASH', module: sheetName, recordId: id, description: 'ย้ายรายการไปถังขยะ' });
    return { deleted: true, trashId: trash.TrashID };
}
function apiRestoreTrash_(input, ctx) {
    const item = findObjectById_('Trash', 'TrashID', String(input.trashId || ''), true);
    if (!item || item.RestoreStatus !== 'DELETED')
        throw appError_('TRASH_ITEM_NOT_FOUND', 'ไม่พบรายการที่สามารถกู้คืนได้');
    assertDepartmentAccess_(ctx, item.DepartmentID);
    if (!DB_SCHEMA[item.SourceSheet])
        throw appError_('TRASH_SOURCE_INVALID', 'ไม่สามารถกู้คืนตารางต้นทางนี้ได้');
    const snapshot = parseJsonSafe_(item.RecordJSON, null);
    if (!snapshot)
        throw appError_('TRASH_DATA_INVALID', 'ข้อมูลสำรองของรายการเสียหาย');
    const field = idFieldForSheet_(item.SourceSheet), record = findObjectById_(item.SourceSheet, field, item.SourceRecordID, true);
    if (!record)
        throw appError_('TRASH_SOURCE_MISSING', 'ไม่พบแถวข้อมูลต้นทางสำหรับกู้คืน');
    if (!record.DeletedAt)
        throw appError_('TRASH_ALREADY_RESTORED', 'รายการนี้ไม่ได้อยู่ในสถานะถูกลบ');
    delete snapshot._rowNumber;
    snapshot.DeletedAt = '';
    snapshot.DeletedBy = '';
    snapshot.UpdatedAt = nowIso_();
    snapshot.UpdatedBy = ctx.userId;
    if (snapshot.Status === 'DELETED')
        snapshot.Status = 'PENDING';
    const restored = updateObjectById_(item.SourceSheet, field, item.SourceRecordID, snapshot);
    updateObjectById_('Trash', 'TrashID', item.TrashID, { RestoreStatus: 'RESTORED', RestoredAt: nowIso_(), RestoredBy: ctx.userId });
    logAudit_({ departmentId: item.DepartmentID, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'RESTORE', module: 'trash', recordId: item.TrashID, description: 'กู้คืนข้อมูลจากถังขยะ' });
    return safeRecord_(restored);
}
function apiPermanentDeleteTrash_(input, ctx) {
    if (input.confirm !== true)
        throw appError_('DELETE_CONFIRMATION_REQUIRED', 'ต้องยืนยัน confirm=true ก่อนลบถาวร');
    const item = findObjectById_('Trash', 'TrashID', String(input.trashId || ''), true);
    if (!item)
        throw appError_('TRASH_ITEM_NOT_FOUND', 'ไม่พบรายการในถังขยะ');
    assertDepartmentAccess_(ctx, item.DepartmentID);
    if (ctx.roleCode !== 'SUPER_ADMIN' && ctx.roleCode !== 'DEPT_ADMIN')
        throw appError_('PERMISSION_DENIED', 'เฉพาะผู้ดูแลระบบเท่านั้นที่ลบถาวรได้');
    const snapshot = parseJsonSafe_(item.RecordJSON, {}), field = idFieldForSheet_(item.SourceSheet);
    if (item.SourceSheet === 'Attachments' && snapshot.DriveFileID) {
        try {
            getPrivateDriveFile_(snapshot.DriveFileID).setTrashed(true);
        }
        catch (ignore) { }
    }
    const sheet = getSheet_('Trash'), row = rowsToObjects_(sheet, { includeDeleted: true }).find(function (r) { return r.TrashID === item.TrashID; });
    if (row)
        sheet.deleteRow(row._rowNumber);
    const source = DB_SCHEMA[item.SourceSheet] ? findObjectById_(item.SourceSheet, field, item.SourceRecordID, true) : null;
    if (source && source.DeletedAt) {
        const sourceSheet = getSheet_(item.SourceSheet);
        const sourceRow = rowsToObjects_(sourceSheet, { includeDeleted: true }).find(function (r) { return String(r[field]) === String(item.SourceRecordID); });
        if (sourceRow)
            sourceSheet.deleteRow(sourceRow._rowNumber);
    }
    logAudit_({ departmentId: item.DepartmentID, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'PERMANENT_DELETE', module: 'trash', recordId: item.TrashID, description: 'ลบข้อมูลออกจากถังขยะถาวร' });
    return { deletedPermanently: true };
}
function idFieldForSheet_(sheetName) {
    const map = { Departments: 'DepartmentID', Users: 'UserID', Roles: 'RoleID', Permissions: 'PermissionID', ReceiveRegister: 'RecordID', SendRegister: 'RecordID', Documents: 'DocumentID', Attachments: 'AttachmentID', Workflow: 'WorkflowID', Assignments: 'AssignmentID', Notifications: 'NotificationID', Categories: 'CategoryID', Settings: 'SettingID', AuditLogs: 'AuditID', DownloadLogs: 'DownloadID', PasswordRecords: 'PasswordReferenceID', Trash: 'TrashID', Sessions: 'SessionID', LoginAttempts: 'AttemptID', PasswordResetRequests: 'RequestID', ImageAssets: 'ImageID', Backups: 'BackupID' };
    return map[sheetName] || '';
}
/* ========================================================================== */
/*  20. PRIVATE DRIVE FOLDERS, BACKUPS AND MAINTENANCE                         */
/* ========================================================================== */
function ensurePrivateDriveRoot_() {
    const props = PropertiesService.getScriptProperties();
    let folderId = props.getProperty(PROP.DRIVE_ROOT_FOLDER_ID), folder = null;
    if (folderId) {
        try {
            folder = DriveApp.getFolderById(folderId);
        }
        catch (ignore) {
            folder = null;
        }
    }
    if (!folder) {
        folder = DriveApp.createFolder(APP_CONFIG.APP_NAME + ' - Private Storage');
        folder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
        props.setProperty(PROP.DRIVE_ROOT_FOLDER_ID, folder.getId());
    }
    return folder;
}
function ensureDepartmentFolders_(departmentId, departmentCode) {
    const department = findObjectById_('Departments', 'DepartmentID', departmentId, true);
    let parentId = department && department.DriveFolderID;
    let parent = null;
    if (parentId) {
        try {
            parent = DriveApp.getFolderById(parentId);
        }
        catch (ignore) {
            parent = null;
        }
    }
    if (!parent) {
        const root = ensurePrivateDriveRoot_();
        parent = root.createFolder(sanitizeFolderName_(departmentCode || departmentId) + '_' + String(departmentId).slice(-8));
        parent.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
        if (department)
            updateObjectById_('Departments', 'DepartmentID', departmentId, { DriveFolderID: parent.getId(), UpdatedAt: nowIso_() });
    }
    const folders = {};
    ['Originals', 'Generated', 'Exports', 'Temp'].forEach(function (name) {
        const iterator = parent.getFoldersByName(name);
        const folder = iterator.hasNext() ? iterator.next() : parent.createFolder(name);
        folder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
        folders[name.toLowerCase() + 'FolderId'] = folder.getId();
    });
    return { departmentFolderId: parent.getId(), originalsFolderId: folders.originalsFolderId, generatedFolderId: folders.generatedFolderId, exportsFolderId: folders.exportsFolderId, tempFolderId: folders.tempFolderId };
}
function getPrivateDriveFile_(fileId) {
    if (!fileId)
        throw appError_('FILE_ID_MISSING', 'ไม่มีรหัสไฟล์ในที่จัดเก็บ');
    try {
        const file = DriveApp.getFileById(String(fileId));
        const rootId = PropertiesService.getScriptProperties().getProperty(PROP.DRIVE_ROOT_FOLDER_ID);
        if (!rootId)
            throw appError_('PRIVATE_STORAGE_NOT_CONFIGURED', 'ยังไม่ได้ตั้งค่าพื้นที่จัดเก็บส่วนตัว');
        // Verify that the file belongs to the private storage tree. A copied or foreign Drive ID is rejected.
        if (!isFileWithinFolderTree_(file, rootId))
            throw appError_('FILE_OUTSIDE_PRIVATE_STORAGE', 'ไฟล์ไม่ได้อยู่ในพื้นที่จัดเก็บของระบบ');
        return file;
    }
    catch (error) {
        if (error && error.code)
            throw error;
        throw appError_('DRIVE_FILE_NOT_FOUND', 'ไม่พบไฟล์ใน Google Drive ส่วนตัว');
    }
}
function isFileWithinFolderTree_(file, rootId) {
    const parents = file.getParents();
    while (parents.hasNext()) {
        const parent = parents.next();
        if (parent.getId() === rootId || isFolderWithinFolderTree_(parent, rootId, 0))
            return true;
    }
    return false;
}
function isFolderWithinFolderTree_(folder, rootId, depth) {
    if (depth > 12)
        return false;
    const parents = folder.getParents();
    while (parents.hasNext()) {
        const parent = parents.next();
        if (parent.getId() === rootId || isFolderWithinFolderTree_(parent, rootId, depth + 1))
            return true;
    }
    return false;
}
function apiListBackups_(input, ctx) {
    if (ctx.roleCode !== 'SUPER_ADMIN')
        throw appError_('PERMISSION_DENIED', 'เฉพาะ Super Admin เท่านั้น');
    const rows = findObjects_('Backups', function () { return true; }, true).sort(function (a, b) { return String(b.CreatedAt).localeCompare(String(a.CreatedAt)); });
    return paginate_(rows.map(function (r) { const item = safeRecord_(r); delete item.DriveFileID; return item; }), input);
}
function apiCreateBackup_(input, ctx) {
    if (ctx.roleCode !== 'SUPER_ADMIN')
        throw appError_('PERMISSION_DENIED', 'เฉพาะ Super Admin เท่านั้น');
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
        const db = getDatabase_(), source = DriveApp.getFileById(db.getId()), root = ensurePrivateDriveRoot_();
        const backupFolderIterator = root.getFoldersByName('Backups'), folder = backupFolderIterator.hasNext() ? backupFolderIterator.next() : root.createFolder('Backups');
        folder.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
        const file = source.makeCopy('Registry_Backup_' + Utilities.formatDate(new Date(), getTimeZone_(), 'yyyyMMdd_HHmmss'), folder);
        file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
        const record = { BackupID: newId_('BKP'), BackupName: file.getName(), DriveFileID: file.getId(), CreatedAt: nowIso_(), CreatedBy: ctx.userId, FileSizeBytes: file.getSize(), Status: 'COMPLETED', Notes: [String(input.notes || '').trim(), 'Google Sheets snapshot only; Drive originals remain in the private storage folder'].filter(Boolean).join(' | ') };
        appendObject_('Backups', record);
        logAudit_({ departmentId: ctx.departmentId, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'CREATE_BACKUP', module: 'system', recordId: record.BackupID, description: 'สำรองฐานข้อมูล Google Sheets' });
        return safeRecord_(record);
    }
    finally {
        lock.releaseLock();
    }
}
function apiRestoreBackup_(input, ctx) {
    if (ctx.roleCode !== 'SUPER_ADMIN')
        throw appError_('PERMISSION_DENIED', 'เฉพาะ Super Admin เท่านั้น');
    if (input.confirm !== true)
        throw appError_('RESTORE_CONFIRMATION_REQUIRED', 'ต้องยืนยัน confirm=true ก่อนกู้คืนฐานข้อมูล');
    const backup = findObjectById_('Backups', 'BackupID', String(input.backupId || ''), true);
    if (!backup || backup.Status !== 'COMPLETED')
        throw appError_('BACKUP_NOT_FOUND', 'ไม่พบข้อมูลสำรองที่สมบูรณ์');
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
        const target = getDatabase_(), currentFile = DriveApp.getFileById(target.getId()), root = ensurePrivateDriveRoot_();
        const emergencyFolderIterator = root.getFoldersByName('Backups'), emergencyFolder = emergencyFolderIterator.hasNext() ? emergencyFolderIterator.next() : root.createFolder('Backups');
        const emergencyFile = currentFile.makeCopy('Registry_Emergency_Before_Restore_' + Utilities.formatDate(new Date(), getTimeZone_(), 'yyyyMMdd_HHmmss'), emergencyFolder);
        emergencyFile.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
        appendObject_('Backups', { BackupID: newId_('BKP'), BackupName: emergencyFile.getName(), DriveFileID: emergencyFile.getId(), CreatedAt: nowIso_(), CreatedBy: ctx.userId, FileSizeBytes: emergencyFile.getSize(), Status: 'COMPLETED', Notes: 'Emergency snapshot before restore' });
        const source = SpreadsheetApp.openById(backup.DriveFileID), staged = [];
        source.getSheets().forEach(function (sourceSheet, index) {
            const tempName = '__RESTORE_' + index + '_' + newId_('TMP').slice(-8);
            sourceSheet.copyTo(target).setName(tempName);
            staged.push({ tempName: tempName, finalName: sourceSheet.getName() });
        });
        // Rename current sheets out of the way only after every backup tab has been staged.
        const oldSheets = target.getSheets().filter(function (sheet) { return staged.every(function (item) { return item.tempName !== sheet.getName(); }); });
        oldSheets.forEach(function (sheet, index) { sheet.setName('__OLD_' + index + '_' + newId_('OLD').slice(-8)); });
        staged.forEach(function (item) { const sheet = target.getSheetByName(item.tempName); if (sheet)
            sheet.setName(item.finalName); });
        target.getSheets().forEach(function (sheet) { if (String(sheet.getName()).indexOf('__OLD_') === 0)
            target.deleteSheet(sheet); });
        ensureAllSchemas_();
        const emergencyBackup = { BackupID: newId_('BKP'), BackupName: emergencyFile.getName(), DriveFileID: emergencyFile.getId(), CreatedAt: nowIso_(), CreatedBy: ctx.userId, FileSizeBytes: emergencyFile.getSize(), Status: 'COMPLETED', Notes: 'Emergency snapshot before restore' };
        if (!findObjectById_('Backups', 'BackupID', backup.BackupID, true))
            appendObject_('Backups', backup);
        if (!findObjectById_('Backups', 'BackupID', emergencyBackup.BackupID, true))
            appendObject_('Backups', emergencyBackup);
        logAudit_({ departmentId: ctx.departmentId, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'RESTORE_BACKUP', module: 'system', recordId: backup.BackupID, description: 'กู้คืนฐานข้อมูลจากข้อมูลสำรอง' });
        return { restored: true, backupId: backup.BackupID, emergencyBackupName: emergencyFile.getName(), driveFilesRestored: false, message: 'กู้คืนข้อมูล Google Sheets แล้ว ไฟล์ต้นฉบับใน Google Drive ไม่ได้ถูกย้อนกลับ' };
    }
    finally {
        lock.releaseLock();
    }
}
function apiRunMaintenance_(input, ctx) {
    if (ctx.roleCode !== 'SUPER_ADMIN')
        throw appError_('PERMISSION_DENIED', 'เฉพาะ Super Admin เท่านั้น');
    const now = Date.now(), result = { expiredSessions: 0, oldLoginAttempts: 0, expiredPasswordRecords: 0, oldResetRequests: 0 };
    findObjects_('Sessions', function (r) { return r.Status === 'ACTIVE' && new Date(r.ExpiresAt).getTime() < now; }, true).forEach(function (r) { updateObjectById_('Sessions', 'SessionID', r.SessionID, { Status: 'EXPIRED', RevokedAt: nowIso_() }); result.expiredSessions++; });
    findObjects_('PasswordRecords', function (r) { return r.ExpiresAt && new Date(r.ExpiresAt).getTime() < now && r.Status === 'ISSUED'; }, true).forEach(function (r) { updateObjectById_('PasswordRecords', 'PasswordReferenceID', r.PasswordReferenceID, { Status: 'EXPIRED' }); result.expiredPasswordRecords++; });
    const cutoff = now - 90 * 86400000;
    findObjects_('LoginAttempts', function (r) { return new Date(r.AttemptedAt).getTime() < cutoff; }, true).forEach(function (r) { const row = rowsToObjects_(getSheet_('LoginAttempts'), { includeDeleted: true }).find(function (x) { return x.AttemptID === r.AttemptID; }); if (row)
        getSheet_('LoginAttempts').deleteRow(row._rowNumber); result.oldLoginAttempts++; });
    findObjects_('PasswordResetRequests', function (r) { return r.Status !== 'PENDING' && new Date(r.RequestedAt).getTime() < cutoff; }, true).forEach(function (r) { const row = rowsToObjects_(getSheet_('PasswordResetRequests'), { includeDeleted: true }).find(function (x) { return x.RequestID === r.RequestID; }); if (row)
        getSheet_('PasswordResetRequests').deleteRow(row._rowNumber); result.oldResetRequests++; });
    logAudit_({ departmentId: ctx.departmentId, userId: ctx.userId, username: ctx.username, roleCode: ctx.roleCode, action: 'MAINTENANCE', module: 'system', description: 'ดำเนินการบำรุงรักษาข้อมูลระบบ' });
    return result;
}
/* ========================================================================== */
/*  21. SHARED QUERY, SCOPE, NUMBERING AND SESSION HELPERS                     */
/* ========================================================================== */
function getPublicConfig_() {
    return {
        appName: APP_CONFIG.APP_NAME,
        appVersion: APP_CONFIG.APP_VERSION,
        timeZone: getTimeZone_(),
        passwordMinLength: APP_CONFIG.PASSWORD_MIN_LENGTH,
        maxUploadBytes: getMaxUploadBytes_(),
        maxDownloadBytes: getMaxDownloadBytes_(),
        passwordDownloadMask: APP_CONFIG.PASSWORD_DOWNLOAD_MASK,
        pdf: { paperSize: 'A4', orientation: 'LANDSCAPE', fontFamily: 'TH Sarabun New', renderer: 'CANVAS_CLIENT' },
        features: {
            multiDepartment: true,
            privateDrive: true,
            protectedDownloads: isAdobePdfServicesConfigured_(),
            protectedDownloadProvider: 'ADOBE_PDF_SERVICES',
            protectedDownloadTypes: ['application/pdf'],
            imgbbUpload: Boolean(PropertiesService.getScriptProperties().getProperty(PROP.IMGBB_API_KEY))
        }
    };
}
function getHealthStatus_() {
    const result = { status: 'OK', database: false, drive: false, imgbbConfigured: false, encryptionConfigured: false, schemaVersion: APP_CONFIG.APP_VERSION, checkedAt: nowIso_() };
    try {
        const db = getDatabase_();
        result.database = Boolean(db.getId());
    }
    catch (ignore) {
        result.status = 'DEGRADED';
    }
    try {
        const rootId = PropertiesService.getScriptProperties().getProperty(PROP.DRIVE_ROOT_FOLDER_ID);
        if (rootId)
            result.drive = Boolean(DriveApp.getFolderById(rootId).getId());
    }
    catch (ignoreDrive) {
        result.status = 'DEGRADED';
    }
    const props = PropertiesService.getScriptProperties();
    result.imgbbConfigured = Boolean(props.getProperty(PROP.IMGBB_API_KEY));
    result.encryptionConfigured = isAdobePdfServicesConfigured_();
    result.encryptionProvider = 'ADOBE_PDF_SERVICES';
    result.encryptionSupportedMimeTypes = ['application/pdf'];
    if (!result.database || !result.drive)
        result.status = 'DEGRADED';
    return result;
}
function getScopedRecord_(sheetName, idField, id, ctx) {
    const key = String(id || ''), record = findObjectById_(sheetName, idField, key, false);
    if (!record)
        throw appError_('RECORD_NOT_FOUND', 'ไม่พบรายการที่ร้องขอ');
    assertDepartmentAccess_(ctx, record.DepartmentID);
    return safeRecord_(record);
}
function assertDepartmentAccess_(ctx, departmentId) {
    if (!ctx || ctx.roleCode !== 'SUPER_ADMIN' && String(ctx.departmentId) !== String(departmentId))
        throw appError_('DEPARTMENT_ACCESS_DENIED', 'ไม่มีสิทธิ์เข้าถึงข้อมูลของหน่วยงานนี้');
    return true;
}
function paginate_(items, input, sortField) {
    const source = Array.isArray(items) ? items.slice() : [], data = input || {}, page = Math.max(1, Math.floor(Number(data.page || 1)));
    const pageSize = Math.min(APP_CONFIG.MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(data.pageSize || APP_CONFIG.DEFAULT_PAGE_SIZE))));
    if (sortField)
        source.sort(function (a, b) { return String(b[sortField] || '').localeCompare(String(a[sortField] || '')); });
    const total = source.length, start = (page - 1) * pageSize;
    return { items: source.slice(start, start + pageSize), page: page, pageSize: pageSize, total: total, totalPages: Math.ceil(total / pageSize), hasNext: start + pageSize < total, hasPrevious: page > 1 };
}
function filterSearch_(items, query, fields) {
    const value = String(query || '').trim().toLowerCase();
    if (!value)
        return items;
    return items.filter(function (record) { return fields.some(function (field) { return String(record[field] || '').toLowerCase().indexOf(value) >= 0; }); });
}
function generateRegisterNumber_(departmentId, type, dateValue) {
    // Called only from apiCreateReceive_ / apiCreateSend_ while the caller holds ScriptLock.
    const department = findObjectById_('Departments', 'DepartmentID', departmentId, false);
    if (!department)
        throw appError_('DEPARTMENT_NOT_FOUND', 'ไม่พบหน่วยงานสำหรับออกเลขทะเบียน');
    const date = new Date(String(dateValue || todayDate_()) + 'T12:00:00');
    if (isNaN(date.getTime()))
        throw appError_('INVALID_REGISTER_DATE', 'วันที่สำหรับออกเลขทะเบียนไม่ถูกต้อง');
    const year = Number(Utilities.formatDate(date, getTimeZone_(), 'yyyy')) + 543;
    const fiscalStart = clampNumber_(department.FiscalYearStartMonth, 1, 12, 10);
    const month = Number(Utilities.formatDate(date, getTimeZone_(), 'M'));
    const fiscalYear = month >= fiscalStart ? year + 1 : year;
    const sheetName = type === 'RECEIVE' ? 'ReceiveRegister' : 'SendRegister';
    const prefix = type === 'RECEIVE' ? (department.ReceivePrefix || 'รับ') : (department.SendPrefix || 'ส่ง');
    const digits = clampNumber_(department.RegisterNumberDigits, 2, 8, 4);
    const registerRows = findObjects_(sheetName, function (r) { return r.DepartmentID === departmentId && Number(r.RegisterYear) === year && !r.DeletedAt; }, true);
    let max = 0;
    registerRows.forEach(function (r) {
        const match = String(r.RegisterNo || '').match(/(\d+)\/\d{4}$/);
        if (match)
            max = Math.max(max, Number(match[1]));
    });
    const next = max + 1, number = String(next).padStart(digits, '0');
    return { registerNo: prefix + ' ' + number + '/' + year, year: year, fiscalYear: fiscalYear, sequence: next };
}
function getSettingNumber_(departmentId, key, fallback) {
    const n = Number(getSettingValue_(departmentId, key, String(fallback)));
    return isFinite(n) ? n : Number(fallback || 0);
}
function revokeUserSessions_(userId) {
    findObjects_('Sessions', function (r) { return r.UserID === userId && r.Status === 'ACTIVE'; }, true).forEach(function (r) { updateObjectById_('Sessions', 'SessionID', r.SessionID, { Status: 'REVOKED', RevokedAt: nowIso_() }); });
}
function revokeDepartmentSessions_(departmentId) {
    findObjects_('Sessions', function (r) { return r.DepartmentID === departmentId && r.Status === 'ACTIVE'; }, true).forEach(function (r) { updateObjectById_('Sessions', 'SessionID', r.SessionID, { Status: 'REVOKED', RevokedAt: nowIso_() }); });
}
function revokeUserSessionsExcept_(userId, keepSessionHash) {
    findObjects_('Sessions', function (r) { return r.UserID === userId && r.Status === 'ACTIVE' && r.SessionHash !== keepSessionHash; }, true).forEach(function (r) { updateObjectById_('Sessions', 'SessionID', r.SessionID, { Status: 'REVOKED', RevokedAt: nowIso_() }); });
}
function normalizeRecordType_(type) {
    const value = String(type || '').toUpperCase();
    const aliases = { RECEIVE: 'RECEIVE', REGISTER_RECEIVE: 'RECEIVE', RECEIVE_REGISTER: 'RECEIVE', SEND: 'SEND', REGISTER_SEND: 'SEND', SEND_REGISTER: 'SEND', DOCUMENT: 'DOCUMENT', DOC: 'DOCUMENT' };
    return aliases[value] || value;
}
function normalizePriority_(priority) {
    const value = String(priority || 'NORMAL').toUpperCase();
    return ['LOW', 'NORMAL', 'HIGH', 'URGENT'].indexOf(value) >= 0 ? value : 'NORMAL';
}
function appendNote_(oldNote, newNote) {
    const note = String(newNote || '').trim();
    if (!note)
        return String(oldNote || '');
    return [String(oldNote || '').trim(), '[' + nowIso_() + '] ' + note].filter(Boolean).join('\n');
}
function normalizeCode_(value) { return String(value || '').trim().toUpperCase().replace(/\s+/g, ''); }
function buildSearchText_(parts) { return (parts || []).map(function (v) { return String(v == null ? '' : v).trim(); }).filter(Boolean).join(' ').toLowerCase(); }
function normalizeDateInput_(value, required) {
    if (value === undefined || value === null || value === '') {
        if (required)
            throw appError_('DATE_REQUIRED', 'กรุณาระบุวันที่');
        return '';
    }
    if (value instanceof Date)
        return Utilities.formatDate(value, getTimeZone_(), 'yyyy-MM-dd');
    const text = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        const date = new Date(text);
        if (isNaN(date.getTime()))
            throw appError_('INVALID_DATE', 'รูปแบบวันที่ไม่ถูกต้อง');
        return Utilities.formatDate(date, getTimeZone_(), 'yyyy-MM-dd');
    }
    const parts = text.split('-').map(Number), check = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    if (check.getUTCFullYear() !== parts[0] || check.getUTCMonth() + 1 !== parts[1] || check.getUTCDate() !== parts[2])
        throw appError_('INVALID_DATE', 'วันที่ไม่มีอยู่จริง');
    return text;
}
function todayDate_() { return Utilities.formatDate(new Date(), getTimeZone_(), 'yyyy-MM-dd'); }
function nowIso_() { return Utilities.formatDate(new Date(), getTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function nowTime_() { return Utilities.formatDate(new Date(), getTimeZone(), 'HH:mm:ss'); }
function today_() { return todayDate_(); }
function addDaysToDate_(dateString, days) {
    const date = new Date(String(dateString) + 'T12:00:00');
    date.setDate(date.getDate() + Number(days || 0));
    return Utilities.formatDate(date, getTimeZone_(), 'yyyy-MM-dd');
}
function getTimeZone_() { return PropertiesService.getScriptProperties().getProperty(PROP.APP_TIMEZONE) || APP_CONFIG.DEFAULT_TIMEZONE; }
function isTrue_(value) { return value === true || String(value).toLowerCase() === 'true' || String(value) === '1' || String(value).toUpperCase() === 'YES'; }
function clampNumber_(value, min, max, fallback) { const number = Number(value); return !isFinite(number) ? fallback : Math.min(max, Math.max(min, Math.floor(number))); }
function parseJsonSafe_(value, fallback) { try {
    return value ? JSON.parse(String(value)) : fallback;
}
catch (ignore) {
    return fallback;
} }
function decodeBase64_(value) {
    try {
        const clean = String(value || '').replace(/^data:[^,]*;base64,/i, '').replace(/\s/g, '');
        return Utilities.base64Decode(clean);
    }
    catch (error) {
        throw appError_('INVALID_BASE64', 'ข้อมูลไฟล์ไม่ถูกต้อง');
    }
}
function getMaxUploadBytes_() {
    const value = Number(PropertiesService.getScriptProperties().getProperty(PROP.MAX_UPLOAD_BYTES) || APP_CONFIG.MAX_UPLOAD_BYTES);
    return isFinite(value) ? Math.min(Math.max(value, 1024), 25 * 1024 * 1024) : APP_CONFIG.MAX_UPLOAD_BYTES;
}
function getMaxDownloadBytes_() {
    const value = Number(PropertiesService.getScriptProperties().getProperty(PROP.MAX_DOWNLOAD_BYTES) || APP_CONFIG.MAX_DOWNLOAD_BYTES);
    return isFinite(value) ? Math.min(Math.max(value, 1024), 25 * 1024 * 1024) : APP_CONFIG.MAX_DOWNLOAD_BYTES;
}
function formatBytes_(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024)
        return value + ' B';
    if (value < 1048576)
        return (value / 1024).toFixed(1) + ' KB';
    return (value / 1048576).toFixed(1) + ' MB';
}
function sanitizeFileName_(name) {
    const text = String(name || 'download').replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').replace(/\s+/g, ' ').trim();
    return text.substring(0, 160) || 'download';
}
function sanitizeFolderName_(name) { return String(name || 'Department').replace(/[\\/:*?"<>|]/g, '_').substring(0, 80); }
function getFileExtension_(name) { const value = String(name || '').toLowerCase(), match = value.match(/\.([a-z0-9]{1,10})$/); return match ? match[1] : ''; }
function safeSheetValue_(value) {
    if (typeof value !== 'string')
        return value;
    const text = value;
    if (/^\s*[=+@\t\r]/.test(text) || /^\s*-(?=[^0-9])/.test(text))
        return "'" + text;
    return text;
}
function safeErrorMessage_(error) {
    if (error && error.code)
        return String(error.message || 'เกิดข้อผิดพลาด');
    if (error && error.message && /Exception:|Service invoked too many times|Authorization is required/i.test(error.message))
        return 'เกิดข้อผิดพลาดในการประมวลผล กรุณาตรวจสอบการตั้งค่าสิทธิ์และลองใหม่';
    return 'ไม่สามารถดำเนินการได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง';
}
function appError_(code, message) { const error = new Error(String(message || 'เกิดข้อผิดพลาด')); error.code = String(code || 'APP_ERROR'); return error; }
function success_(data) { return { success: true, data: data }; }
function logAudit_(data) {
    try {
        appendObject_('AuditLogs', { AuditID: newId_('AUD'), DepartmentID: data.departmentId || '', UserID: data.userId || '', Username: data.username || '', RoleCode: data.roleCode || '', Action: data.action || '', Module: data.module || '', RecordID: data.recordId || '', RecordType: data.recordType || '', Description: String(data.description || ''), BeforeJSON: data.before ? JSON.stringify(data.before) : '', AfterJSON: data.after ? JSON.stringify(data.after) : '', Result: 'SUCCESS', IPHint: '', UserAgentHint: '', CreatedAt: nowIso_() });
    }
    catch (ignore) { /* Audit failure must not expose secrets or block the main transaction. */ }
}

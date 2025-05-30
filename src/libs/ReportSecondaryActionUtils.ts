import type {OnyxCollection} from 'react-native-onyx';
import type {ValueOf} from 'type-fest';
import CONST from '@src/CONST';
import type {Policy, Report, ReportAction, Transaction, TransactionViolation} from '@src/types/onyx';
import {isApprover as isApproverUtils} from './actions/Policy/Member';
import {getCurrentUserAccountID, getCurrentUserEmail} from './actions/Report';
import {
    arePaymentsEnabled as arePaymentsEnabledUtils,
    getAllPolicies,
    getConnectedIntegration,
    getCorrectedAutoReportingFrequency,
    getSubmitToAccountID,
    hasAccountingConnections,
    hasIntegrationAutoSync,
    hasNoPolicyOtherThanPersonalType,
    isPrefferedExporter,
    isWorkspaceEligibleForReportChange,
} from './PolicyUtils';
import {getIOUActionForReportID, getReportActions, isPayAction} from './ReportActionsUtils';
import {
    canAddTransaction,
    isClosedReport as isClosedReportUtils,
    isCurrentUserSubmitter,
    isExpenseReport as isExpenseReportUtils,
    isExported as isExportedUtils,
    isInvoiceReport as isInvoiceReportUtils,
    isIOUReport as isIOUReportUtils,
    isOpenReport as isOpenReportUtils,
    isPayer as isPayerUtils,
    isProcessingReport as isProcessingReportUtils,
    isReportApproved as isReportApprovedUtils,
    isReportManager as isReportManagerUtils,
    isSettled,
} from './ReportUtils';
import {getSession} from './SessionUtils';
import {allHavePendingRTERViolation, isDuplicate, isOnHold as isOnHoldTransactionUtils, shouldShowBrokenConnectionViolationForMultipleTransactions} from './TransactionUtils';

function isAddExpenseAction(report: Report, reportTransactions: Transaction[]) {
    const isReportSubmitter = isCurrentUserSubmitter(report.reportID);

    if (!isReportSubmitter || reportTransactions.length === 0) {
        return false;
    }

    return canAddTransaction(report);
}

function isSubmitAction(report: Report, reportTransactions: Transaction[], policy?: Policy): boolean {
    const transactionAreComplete = reportTransactions.every((transaction) => transaction.amount !== 0 || transaction.modifiedAmount !== 0);

    if (!transactionAreComplete) {
        return false;
    }

    const isExpenseReport = isExpenseReportUtils(report);

    if (!isExpenseReport || report?.total === 0) {
        return false;
    }

    const isReportSubmitter = isCurrentUserSubmitter(report.reportID);
    const isReportApprover = isApproverUtils(policy, getCurrentUserAccountID());
    if (!isReportSubmitter && !isReportApprover) {
        return false;
    }

    const isOpenReport = isOpenReportUtils(report);
    if (!isOpenReport) {
        return false;
    }

    const submitToAccountID = getSubmitToAccountID(policy, report);
    if (submitToAccountID === report.ownerAccountID && policy?.preventSelfApproval) {
        return false;
    }

    const isAdmin = policy?.role === CONST.POLICY.ROLE.ADMIN;
    if (isAdmin) {
        return true;
    }

    const autoReportingFrequency = getCorrectedAutoReportingFrequency(policy);

    const isScheduledSubmitEnabled = policy?.harvesting?.enabled && autoReportingFrequency !== CONST.POLICY.AUTO_REPORTING_FREQUENCIES.MANUAL;

    return !!isScheduledSubmitEnabled;
}

function isApproveAction(report: Report, reportTransactions: Transaction[], violations: OnyxCollection<TransactionViolation[]>, policy?: Policy): boolean {
    const isExpenseReport = isExpenseReportUtils(report);
    const isReportApprover = isApproverUtils(policy, getCurrentUserAccountID());
    const isProcessingReport = isProcessingReportUtils(report);
    const reportHasDuplicatedTransactions = reportTransactions.some((transaction) => isDuplicate(transaction.transactionID));

    const isPreventSelfApprovalEnabled = policy?.preventSelfApproval;
    const isReportSubmitter = isCurrentUserSubmitter(report.reportID);

    if (isPreventSelfApprovalEnabled && isReportSubmitter) {
        return false;
    }

    if (isExpenseReport && isReportApprover && isProcessingReport && reportHasDuplicatedTransactions) {
        return true;
    }

    const transactionIDs = reportTransactions.map((t) => t.transactionID);

    const hasAllPendingRTERViolations = allHavePendingRTERViolation(transactionIDs, violations);

    if (hasAllPendingRTERViolations) {
        return true;
    }

    const isAdmin = policy?.role === CONST.POLICY.ROLE.ADMIN;

    const shouldShowBrokenConnectionViolation = shouldShowBrokenConnectionViolationForMultipleTransactions(transactionIDs, report, policy, violations);

    const userControlsReport = isReportApprover || isAdmin;
    return userControlsReport && shouldShowBrokenConnectionViolation;
}

function isUnapproveAction(report: Report, policy?: Policy): boolean {
    const isExpenseReport = isExpenseReportUtils(report);
    const isReportApprover = isApproverUtils(policy, getCurrentUserAccountID());
    const isReportApproved = isReportApprovedUtils({report});
    const isReportSettled = isSettled(report);
    const isPaymentProcessing = report.isWaitingOnBankAccount && report.statusNum === CONST.REPORT.STATUS_NUM.APPROVED;

    if (isReportSettled || isPaymentProcessing) {
        return false;
    }

    return isExpenseReport && isReportApprover && isReportApproved;
}

function isCancelPaymentAction(report: Report, reportTransactions: Transaction[], policy?: Policy): boolean {
    const isExpenseReport = isExpenseReportUtils(report);

    if (!isExpenseReport) {
        return false;
    }

    const isAdmin = policy?.role === CONST.POLICY.ROLE.ADMIN;
    const isPayer = isPayerUtils(getSession(), report, false, policy);

    if (!isAdmin || !isPayer) {
        return false;
    }

    const isReportPaidElsewhere = report.stateNum === CONST.REPORT.STATE_NUM.APPROVED && report.statusNum === CONST.REPORT.STATUS_NUM.REIMBURSED;

    if (isReportPaidElsewhere) {
        return true;
    }

    const isPaymentProcessing = !!report.isWaitingOnBankAccount && report.statusNum === CONST.REPORT.STATUS_NUM.APPROVED;

    const payActions = reportTransactions.reduce((acc, transaction) => {
        const action = getIOUActionForReportID(report.reportID, transaction.transactionID);
        if (action && isPayAction(action)) {
            acc.push(action);
        }
        return acc;
    }, [] as ReportAction[]);

    const hasDailyNachaCutoffPassed = payActions.some((action) => {
        const now = new Date();
        const paymentDatetime = new Date(action.created);
        const nowUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()));
        const cutoffTimeUTC = new Date(Date.UTC(paymentDatetime.getUTCFullYear(), paymentDatetime.getUTCMonth(), paymentDatetime.getUTCDate(), 23, 45, 0));
        return nowUTC.getTime() < cutoffTimeUTC.getTime();
    });

    return isPaymentProcessing && !hasDailyNachaCutoffPassed;
}

function isExportAction(report: Report, policy?: Policy): boolean {
    if (!policy) {
        return false;
    }

    const hasAccountingConnection = hasAccountingConnections(policy);
    if (!hasAccountingConnection) {
        return false;
    }

    const isInvoiceReport = isInvoiceReportUtils(report);
    const isReportSender = isCurrentUserSubmitter(report.reportID);

    if (isInvoiceReport && isReportSender) {
        return true;
    }

    const isExpenseReport = isExpenseReportUtils(report);

    if (!isExpenseReport) {
        return false;
    }

    const isReportApproved = isReportApprovedUtils({report});
    const isReportPayer = isPayerUtils(getSession(), report, false, policy);
    const arePaymentsEnabled = arePaymentsEnabledUtils(policy);
    const isReportClosed = isClosedReportUtils(report);

    if (isReportPayer && arePaymentsEnabled && (isReportApproved || isReportClosed)) {
        return true;
    }

    const isAdmin = policy?.role === CONST.POLICY.ROLE.ADMIN;
    const isReportReimbursed = report.statusNum === CONST.REPORT.STATUS_NUM.REIMBURSED;
    const connectedIntegration = getConnectedIntegration(policy);
    const syncEnabled = hasIntegrationAutoSync(policy, connectedIntegration);
    const isReportExported = isExportedUtils(getReportActions(report));
    const isReportFinished = isReportApproved || isReportReimbursed || isReportClosed;

    return isAdmin && isReportFinished && syncEnabled && !isReportExported;
}

function isMarkAsExportedAction(report: Report, policy?: Policy): boolean {
    if (!policy) {
        return false;
    }

    const hasAccountingConnection = hasAccountingConnections(policy);
    if (!hasAccountingConnection) {
        return false;
    }

    const isInvoiceReport = isInvoiceReportUtils(report);
    const isReportSender = isCurrentUserSubmitter(report.reportID);

    if (isInvoiceReport && isReportSender) {
        return true;
    }

    const isExpenseReport = isExpenseReportUtils(report);

    if (!isExpenseReport) {
        return false;
    }

    const isReportPayer = isPayerUtils(getSession(), report, false, policy);
    const arePaymentsEnabled = arePaymentsEnabledUtils(policy);
    const isReportApproved = isReportApprovedUtils({report});
    const isReportClosed = isClosedReportUtils(report);
    const isReportClosedOrApproved = isReportClosed || isReportApproved;

    if (isReportPayer && arePaymentsEnabled && isReportClosedOrApproved) {
        return true;
    }

    const isReportReimbursed = isSettled(report);
    const connectedIntegration = getConnectedIntegration(policy);
    const syncEnabled = hasIntegrationAutoSync(policy, connectedIntegration);
    const isReportFinished = isReportClosedOrApproved || isReportReimbursed;

    if (!isReportFinished || !syncEnabled) {
        return false;
    }

    const isAdmin = policy?.role === CONST.POLICY.ROLE.ADMIN;

    const isExporter = isPrefferedExporter(policy);

    return isAdmin || isExporter;
}

function isHoldAction(report: Report, reportTransactions: Transaction[]): boolean {
    const isOneExpenseReport = reportTransactions.length === 1;
    const transaction = reportTransactions.at(0);

    if (!isOneExpenseReport || !transaction) {
        return false;
    }

    const isTransactionOnHold = isHoldActionForTransation(report, transaction);
    return isTransactionOnHold;
}

function isHoldActionForTransation(report: Report, reportTransaction: Transaction): boolean {
    const isExpenseReport = isExpenseReportUtils(report);
    const isIOUReport = isIOUReportUtils(report);
    const iouOrExpenseReport = isExpenseReport || isIOUReport;

    if (!iouOrExpenseReport) {
        return false;
    }

    const isReportOnHold = isOnHoldTransactionUtils(reportTransaction);

    if (isReportOnHold) {
        return false;
    }

    const isOpenReport = isOpenReportUtils(report);
    const isSubmitter = isCurrentUserSubmitter(report.reportID);

    if (isOpenReport && isSubmitter) {
        return true;
    }

    const isProcessingReport = isProcessingReportUtils(report);

    return isProcessingReport;
}

function isChangeWorkspaceAction(report: Report, reportTransactions: Transaction[], violations: OnyxCollection<TransactionViolation[]>, policy?: Policy): boolean {
    const isExpenseReport = isExpenseReportUtils(report);
    const isReportSubmitter = isCurrentUserSubmitter(report.reportID);
    const areWorkflowsEnabled = !!(policy && policy.areWorkflowsEnabled);
    const isClosedReport = isClosedReportUtils(report);

    const policies = getAllPolicies();
    const currentUserEmail = getCurrentUserEmail();
    const policiesEligibleForChange = policies.filter((newPolicy) => isWorkspaceEligibleForReportChange(newPolicy, report, policy, currentUserEmail));

    if (policiesEligibleForChange.length <= 1) {
        return false;
    }

    if (isExpenseReport && isReportSubmitter && !areWorkflowsEnabled && isClosedReport) {
        return true;
    }

    const isOpenReport = isOpenReportUtils(report);
    const isProcessingReport = isProcessingReportUtils(report);

    if (isReportSubmitter && (isOpenReport || isProcessingReport)) {
        return true;
    }

    const isReportApprover = isApproverUtils(policy, getCurrentUserAccountID());

    if (isReportApprover && isProcessingReport) {
        return true;
    }

    const isReportPayer = isPayerUtils(getSession(), report, false, policy);
    const isReportApproved = isReportApprovedUtils({report});

    if (isReportPayer && (isReportApproved || isClosedReport)) {
        return true;
    }

    const isAdmin = policy?.role === CONST.POLICY.ROLE.ADMIN;
    const isReportReimbursed = isSettled(report);
    const transactionIDs = reportTransactions.map((t) => t.transactionID);
    const hasAllPendingRTERViolations = allHavePendingRTERViolation(transactionIDs, violations);

    const shouldShowBrokenConnectionViolation = shouldShowBrokenConnectionViolationForMultipleTransactions(transactionIDs, report, policy, violations);

    const userControlsReport = isReportSubmitter || isReportApprover || isAdmin;
    const hasReceiptMatchViolation = hasAllPendingRTERViolations || (userControlsReport && shouldShowBrokenConnectionViolation);
    const isReportExported = isExportedUtils(getReportActions(report));
    const isReportFinished = isReportApproved || isReportReimbursed || isClosedReport;

    if (isAdmin && ((!isReportExported && isReportFinished) || hasReceiptMatchViolation)) {
        return true;
    }

    const isIOUReport = isIOUReportUtils(report);
    const hasOnlyPersonalWorkspace = hasNoPolicyOtherThanPersonalType();
    const isReportReceiver = isReportManagerUtils(report);

    if (isIOUReport && !hasOnlyPersonalWorkspace && isReportReceiver && isReportReimbursed) {
        return true;
    }

    return false;
}

function isDeleteAction(report: Report, reportTransactions: Transaction[]): boolean {
    const isExpenseReport = isExpenseReportUtils(report);
    const isIOUReport = isIOUReportUtils(report);

    // This should be removed when is merged https://github.com/Expensify/App/pull/58020
    const isSingleTransaction = reportTransactions.length === 1;

    if ((!isExpenseReport && !isIOUReport) || !isSingleTransaction) {
        return false;
    }

    const isReportSubmitter = isCurrentUserSubmitter(report.reportID);

    if (!isReportSubmitter) {
        return false;
    }

    const isReportOpen = isOpenReportUtils(report);
    const isProcessingReport = isProcessingReportUtils(report);
    const isReportApproved = isReportApprovedUtils({report});

    if (isReportApproved) {
        return false;
    }

    return isReportOpen || isProcessingReport;
}

function getSecondaryReportActions(
    report: Report,
    reportTransactions: Transaction[],
    violations: OnyxCollection<TransactionViolation[]>,
    policy?: Policy,
): Array<ValueOf<typeof CONST.REPORT.SECONDARY_ACTIONS>> {
    const options: Array<ValueOf<typeof CONST.REPORT.SECONDARY_ACTIONS>> = [];

    if (isAddExpenseAction(report, reportTransactions)) {
        options.push(CONST.REPORT.SECONDARY_ACTIONS.ADD_EXPENSE);
    }

    if (isSubmitAction(report, reportTransactions, policy)) {
        options.push(CONST.REPORT.SECONDARY_ACTIONS.SUBMIT);
    }

    if (isApproveAction(report, reportTransactions, violations, policy)) {
        options.push(CONST.REPORT.SECONDARY_ACTIONS.APPROVE);
    }

    if (isUnapproveAction(report, policy)) {
        options.push(CONST.REPORT.SECONDARY_ACTIONS.UNAPPROVE);
    }

    if (isCancelPaymentAction(report, reportTransactions, policy)) {
        options.push(CONST.REPORT.SECONDARY_ACTIONS.CANCEL_PAYMENT);
    }

    if (isExportAction(report, policy)) {
        options.push(CONST.REPORT.SECONDARY_ACTIONS.EXPORT_TO_ACCOUNTING);
    }

    if (isMarkAsExportedAction(report, policy)) {
        options.push(CONST.REPORT.SECONDARY_ACTIONS.MARK_AS_EXPORTED);
    }

    if (isHoldAction(report, reportTransactions)) {
        options.push(CONST.REPORT.SECONDARY_ACTIONS.HOLD);
    }

    options.push(CONST.REPORT.SECONDARY_ACTIONS.DOWNLOAD);

    if (isChangeWorkspaceAction(report, reportTransactions, violations, policy)) {
        options.push(CONST.REPORT.SECONDARY_ACTIONS.CHANGE_WORKSPACE);
    }

    options.push(CONST.REPORT.SECONDARY_ACTIONS.VIEW_DETAILS);

    if (isDeleteAction(report, reportTransactions)) {
        options.push(CONST.REPORT.SECONDARY_ACTIONS.DELETE);
    }

    return options;
}

function getSecondaryTransactionThreadActions(parentReport: Report, reportTransaction: Transaction): Array<ValueOf<typeof CONST.REPORT.TRANSACTION_SECONDARY_ACTIONS>> {
    const options: Array<ValueOf<typeof CONST.REPORT.TRANSACTION_SECONDARY_ACTIONS>> = [];

    if (isHoldActionForTransation(parentReport, reportTransaction)) {
        options.push(CONST.REPORT.TRANSACTION_SECONDARY_ACTIONS.HOLD);
    }

    options.push(CONST.REPORT.TRANSACTION_SECONDARY_ACTIONS.VIEW_DETAILS);

    if (isDeleteAction(parentReport, [reportTransaction])) {
        options.push(CONST.REPORT.TRANSACTION_SECONDARY_ACTIONS.DELETE);
    }

    return options;
}
export {getSecondaryReportActions, getSecondaryTransactionThreadActions};

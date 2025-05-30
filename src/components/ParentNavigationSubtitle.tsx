import React from 'react';
import type {StyleProp, ViewStyle} from 'react-native';
import {useOnyx} from 'react-native-onyx';
import useLocalize from '@hooks/useLocalize';
import useThemeStyles from '@hooks/useThemeStyles';
import Navigation from '@libs/Navigation/Navigation';
import {getReportAction, shouldReportActionBeVisible} from '@libs/ReportActionsUtils';
import {canUserPerformWriteAction as canUserPerformWriteActionReportUtils} from '@libs/ReportUtils';
import CONST from '@src/CONST';
import type {ParentNavigationSummaryParams} from '@src/languages/params';
import ONYXKEYS from '@src/ONYXKEYS';
import ROUTES from '@src/ROUTES';
import PressableWithoutFeedback from './Pressable/PressableWithoutFeedback';
import Text from './Text';

type ParentNavigationSubtitleProps = {
    parentNavigationSubtitleData: ParentNavigationSummaryParams;

    /** parent Report ID */
    parentReportID?: string;

    /** parent Report Action ID */
    parentReportActionID?: string;

    /** PressableWithoutFeedback additional styles */
    pressableStyles?: StyleProp<ViewStyle>;
};

function ParentNavigationSubtitle({parentNavigationSubtitleData, parentReportActionID, parentReportID = '', pressableStyles}: ParentNavigationSubtitleProps) {
    const styles = useThemeStyles();
    const {workspaceName, reportName} = parentNavigationSubtitleData;
    const {translate} = useLocalize();
    const [report] = useOnyx(`${ONYXKEYS.COLLECTION.REPORT}${parentReportID}`);
    const canUserPerformWriteAction = canUserPerformWriteActionReportUtils(report);

    // We should not display the parent navigation subtitle if the user does not have access to the parent chat (the reportName is empty in this case)
    if (!reportName) {
        return;
    }

    return (
        <PressableWithoutFeedback
            onPress={() => {
                const parentAction = getReportAction(parentReportID, parentReportActionID);
                const isVisibleAction = shouldReportActionBeVisible(parentAction, parentAction?.reportActionID ?? CONST.DEFAULT_NUMBER_ID, canUserPerformWriteAction);
                if (isVisibleAction) {
                    Navigation.navigate(ROUTES.REPORT_WITH_ID.getRoute(parentReportID, parentReportActionID));
                } else {
                    Navigation.navigate(ROUTES.REPORT_WITH_ID.getRoute(parentReportID));
                }
            }}
            accessibilityLabel={translate('threads.parentNavigationSummary', {reportName, workspaceName})}
            role={CONST.ROLE.LINK}
            style={pressableStyles}
        >
            <Text
                style={[styles.optionAlternateText, styles.textLabelSupporting]}
                numberOfLines={1}
            >
                {!!reportName && (
                    <>
                        <Text style={[styles.optionAlternateText, styles.textLabelSupporting]}>{`${translate('threads.from')} `}</Text>
                        <Text style={[styles.optionAlternateText, styles.textLabelSupporting, styles.link]}>{reportName}</Text>
                    </>
                )}
                {!!workspaceName && workspaceName !== reportName && (
                    <Text style={[styles.optionAlternateText, styles.textLabelSupporting]}>{` ${translate('threads.in')} ${workspaceName}`}</Text>
                )}
            </Text>
        </PressableWithoutFeedback>
    );
}

ParentNavigationSubtitle.displayName = 'ParentNavigationSubtitle';
export default ParentNavigationSubtitle;

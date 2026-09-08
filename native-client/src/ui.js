import dialogHelper from 'components/dialogHelper/dialogHelper';
import actionSheet from 'components/actionSheet/actionSheet';
import toast from 'components/toast/toast';
import 'elements/emby-button/emby-button';
import 'elements/emby-input/emby-input';
import 'components/formdialog.scss';
import { createNativeUi } from './uiCore';
import './ui.css';

export const { chooseAccount, confirmServerChange, showWatchMenu, showLoading, showStartupError, showClosed, mountPlaybackPermission } =
    createNativeUi({ document, dialogHelper, actionSheet, toast });

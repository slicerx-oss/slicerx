### Fixed

- `slicerx_push_status` shows a partner registration's `mayApprove` as the phone's approve right is now, after the person turns it on or off in Devices. Before, it kept the right the phone had when it registered, and a phone given approve later never got approval alerts.
- A partner phone gets no approval alert for a card a partner app asked for, or one the hub can't tell who asked for, since it may never approve those.

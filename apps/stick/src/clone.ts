/**
 * Every trooper image from the clone-container release carries it: such an image runs the `clone`
 * role, which fetches a GitLab project into the drop's mirror before the agent starts. The stick
 * reads nothing else from it yet.
 */
export const TROOPER_CLONE_LABEL = 'org.jumpmaster.trooper.clone';
export const TROOPER_CLONE_VERSION = '1';

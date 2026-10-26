// Fix-it reference text for every accessibility finding: what it is, why it matters, how to fix it and the WCAG
// success criteria it touches (each with a link). Pure data and lookups; shown in finding details and in the
// Page map's marker details. axe findings use axe's own help text and rule page, with its WCAG tags mapped to criteria.

const U = (slug) => `https://www.w3.org/WAI/WCAG22/Understanding/${slug}.html`;
/** Success criterion number to [name, Understanding page slug]. */
export const WCAG = {
  '1.1.1': ['Non-text Content', 'non-text-content'],
  '1.2.1': ['Audio-only and Video-only (Prerecorded)', 'audio-only-and-video-only-prerecorded'],
  '1.2.2': ['Captions (Prerecorded)', 'captions-prerecorded'],
  '1.2.3': ['Audio Description or Media Alternative (Prerecorded)', 'audio-description-or-media-alternative-prerecorded'],
  '1.2.5': ['Audio Description (Prerecorded)', 'audio-description-prerecorded'],
  '1.3.1': ['Info and Relationships', 'info-and-relationships'],
  '1.3.2': ['Meaningful Sequence', 'meaningful-sequence'],
  '1.3.4': ['Orientation', 'orientation'],
  '1.3.5': ['Identify Input Purpose', 'identify-input-purpose'],
  '1.4.1': ['Use of Color', 'use-of-color'],
  '1.4.2': ['Audio Control', 'audio-control'],
  '1.4.3': ['Contrast (Minimum)', 'contrast-minimum'],
  '1.4.4': ['Resize Text', 'resize-text'],
  '1.4.5': ['Images of Text', 'images-of-text'],
  '1.4.6': ['Contrast (Enhanced)', 'contrast-enhanced'],
  '1.4.8': ['Visual Presentation', 'visual-presentation'],
  '1.4.10': ['Reflow', 'reflow'],
  '1.4.11': ['Non-text Contrast', 'non-text-contrast'],
  '1.4.12': ['Text Spacing', 'text-spacing'],
  '1.4.13': ['Content on Hover or Focus', 'content-on-hover-or-focus'],
  '2.1.1': ['Keyboard', 'keyboard'],
  '2.1.2': ['No Keyboard Trap', 'no-keyboard-trap'],
  '2.2.1': ['Timing Adjustable', 'timing-adjustable'],
  '2.2.2': ['Pause, Stop, Hide', 'pause-stop-hide'],
  '2.4.1': ['Bypass Blocks', 'bypass-blocks'],
  '2.4.2': ['Page Titled', 'page-titled'],
  '2.4.3': ['Focus Order', 'focus-order'],
  '2.4.4': ['Link Purpose (In Context)', 'link-purpose-in-context'],
  '2.4.5': ['Multiple Ways', 'multiple-ways'],
  '2.4.6': ['Headings and Labels', 'headings-and-labels'],
  '2.4.7': ['Focus Visible', 'focus-visible'],
  '2.4.9': ['Link Purpose (Link Only)', 'link-purpose-link-only'],
  '2.4.10': ['Section Headings', 'section-headings'],
  '2.4.11': ['Focus Not Obscured (Minimum)', 'focus-not-obscured-minimum'],
  '2.5.1': ['Pointer Gestures', 'pointer-gestures'],
  '2.5.3': ['Label in Name', 'label-in-name'],
  '2.5.5': ['Target Size (Enhanced)', 'target-size-enhanced'],
  '2.5.8': ['Target Size (Minimum)', 'target-size-minimum'],
  '3.1.1': ['Language of Page', 'language-of-page'],
  '3.1.2': ['Language of Parts', 'language-of-parts'],
  '3.2.1': ['On Focus', 'on-focus'],
  '3.2.2': ['On Input', 'on-input'],
  '3.3.1': ['Error Identification', 'error-identification'],
  '3.3.2': ['Labels or Instructions', 'labels-or-instructions'],
  '4.1.1': ['Parsing', 'parsing'],
  '4.1.2': ['Name, Role, Value', 'name-role-value'],
  '4.1.3': ['Status Messages', 'status-messages'],
};

/** One success criterion as { sc, name, url }; a criterion not in the table links to the quick reference. */
export function wcagLink(sc) {
  const [name, slug] = WCAG[sc] || [];
  return { sc, name: name || '', url: slug ? U(slug) : 'https://www.w3.org/WAI/WCAG22/quickref/' };
}

/** "1.4.3 Contrast (Minimum)" for a link's text. */
export const wcagLabel = (w) => `${w.sc}${w.name ? ` ${w.name}` : ''}`;

/** axe tags such as wcag111 or wcag1410 to criteria ("1.1.1", "1.4.10"); level tags (wcag2a, wcag21aa) and others are ignored. */
export function wcagFromTags(tags = []) {
  const out = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    const m = /^wcag(\d)(\d)(\d{1,2})$/.exec(String(t));
    if (m) out.push(`${m[1]}.${m[2]}.${m[3]}`);
  }
  return [...new Set(out)];
}

const r = (what, why, fix, wcag = []) => ({ what, why, fix, wcag });

/** Reference text by finding key (the finding's `id`): HARgus's own checks. axe rules come from axe. */
export const REFERENCE = {
  // a11y-basics
  'html-lang': r('The <html> element has no lang attribute.', 'Screen readers choose a pronunciation and braille tables from the page language; without it text can be read in the wrong voice.', 'Add the language of the page: <html lang="en">.', ['3.1.1']),
  'document-title': r('The page has no <title>, or it is empty.', 'The title is the first thing a screen reader announces and the label of the browser tab and of history entries.', 'Give every page a short, unique <title> that says what the page is.', ['2.4.2']),
  'image-alt': r('An image has no alt attribute.', 'Without alt, a screen reader reads the file name or skips the image, and the information in it is lost.', 'Add alt text that conveys the image\'s purpose, or alt="" if it is purely decorative.', ['1.1.1']),
  'input-label': r('A form field has no label.', 'Screen reader users hear only "edit text" and cannot tell what to enter; voice users cannot name the field.', 'Associate a visible <label for="id"> with the field, or wrap the field in the label. Use aria-label only when no visible text can exist.', ['1.3.1', '3.3.2', '4.1.2']),
  'button-name': r('A button has no accessible name.', 'A screen reader announces only "button", so users cannot tell what it does.', 'Put text inside the button, or give an icon button an aria-label (or visually hidden text) that says the action.', ['4.1.2']),
  'link-name': r('A link has no accessible name.', 'A screen reader announces only "link" and the address, so users cannot tell where it goes.', 'Put text in the link, or alt text on the image inside it, or an aria-label that says the destination.', ['2.4.4', '4.1.2']),
  'frame-title': r('An iframe has no title.', 'Screen reader users move between frames by their titles; an untitled frame gives no hint what it holds.', 'Add a short title attribute that describes the frame\'s content.', ['4.1.2', '2.4.1']),
  'meta-viewport': r('The viewport meta tag disables or limits zoom (user-scalable=no or a low maximum-scale).', 'People with low vision rely on pinch zoom to read the page.', 'Remove user-scalable=no and maximum-scale (or set it to at least 2): <meta name="viewport" content="width=device-width, initial-scale=1">.', ['1.4.4']),
  'duplicate-id': r('More than one element uses the same id.', 'Labels, aria-labelledby, aria-describedby and in-page links pick the wrong element, or only the first.', 'Make every id unique on the page.', ['4.1.1']),
  tabindex: r('An element has a positive tabindex.', 'It jumps ahead of everything else in the Tab order, so keyboard users move through the page out of reading order.', 'Use tabindex="0" or none, and put elements in the DOM in the order users should reach them.', ['2.4.3']),
  'autoplay-audio': r('Audio or video plays automatically with sound.', 'It talks over a screen reader and cannot be silenced by users who cannot find the control.', 'Do not autoplay with sound; start muted, or provide a pause control that is reachable first.', ['1.4.2']),
  'focusable-hidden': r('A focusable element sits inside aria-hidden="true".', 'Keyboard users can land on something screen readers have been told is not there.', 'Remove aria-hidden from the container, or take the element out of the Tab order (tabindex="-1", disabled, or inert).', ['4.1.2']),
  'fieldset-legend': r('A <fieldset> has no <legend>, or the legend is empty.', 'The legend names the group; without it a screen reader user hears the fields with no context (for example three radios that read only "Yes", "No" and "Maybe").', 'Add <legend> as the first child of the fieldset, with a short name for the group.', ['1.3.1', '3.3.2']),
  'label-empty': r('A <label> is attached to a field but contains no text or image alt.', 'The field is announced with no name even though a label exists.', 'Put the label text inside the <label>, or remove the empty label and name the field another way.', ['1.3.1', '3.3.2', '4.1.2']),
  'label-orphaned': r('A <label> is not attached to a form control: it has no for and wraps no control, or its for points to something that cannot be labelled (a for pointing to a missing id is reported as a broken reference).', 'Clicking the label does nothing, and the field it was meant for has no name.', 'Set for to the id of the field (or wrap the field in the label), and make sure that element can take a label.', ['1.3.1', '3.3.2']),
  'label-multiple': r('A form control has two or more <label>s.', 'Screen readers combine or pick between them inconsistently, so the field name can come out doubled or wrong.', 'Keep one label per field; merge the text, or use aria-describedby for extra help text.', ['1.3.1', '3.3.2']),
  'link-broken-anchor': r('A link points to #something, but no element has that id (or an <a name>).', 'Activating it does nothing visible; skip links and tables of contents that fail strand keyboard and screen reader users.', 'Fix the fragment, add the missing id to the target, or remove the link. Links to "#" and "#top" are not reported.', ['2.4.1', '2.4.4']),
  'link-redundant': r('Two links in a row go to the same address.', 'Screen reader and keyboard users hear and tab through the same destination twice.', 'Combine them into one link (put the image and the text inside a single <a>), or hide the duplicate with aria-hidden="true" and tabindex="-1".', ['2.4.4']),
  'title-redundant': r('A title attribute repeats the element\'s visible text or alt text.', 'Some screen readers announce both, so the same words are heard twice; the tooltip adds nothing.', 'Remove the title, or make it add information the visible text does not.', ['2.4.4']),
  'video-captions': r('A <video> has no captions or subtitles track.', 'Deaf and hard-of-hearing people cannot follow the speech and sounds.', 'Add <track kind="captions" src="..." srclang="en" label="English"> with a WebVTT file. A muted looping or autoplaying video without controls is treated as decoration and not reported.', ['1.2.2']),
  'media-embed': r('A YouTube or Vimeo player is embedded.', 'HARgus cannot see inside the player whether it has captions or audio description.', 'Check in the player that captions are available, and provide a transcript where useful.', ['1.2.2', '1.2.5']),
  'layout-table': r('A <table> has no header cells or caption and looks like it is used for layout (one row or column, or layout-like content).', 'Screen readers announce table structure (row and column counts, cell navigation) that carries no meaning for layout.', 'Lay the page out with CSS. If it is a real data table, add <th> header cells and a <caption>; if it must stay, add role="presentation".', ['1.3.1']),
  // a11y-structure: headings and landmarks
  'headings-skipped': r('Heading levels skip (for example an h2 followed by an h4).', 'Screen reader users navigate by heading level; a gap suggests missing content or a broken outline.', 'Nest headings one level at a time and choose levels for structure, not for size (style with CSS).', ['1.3.1', '2.4.6']),
  'headings-empty': r('A heading has no text.', 'It is announced as an empty heading and clutters the heading list.', 'Add text, or remove the heading element and use CSS for spacing.', ['1.3.1', '2.4.6']),
  'headings-duplicate': r('Several headings have the same text.', 'In the heading list they cannot be told apart.', 'Make each heading specific, or add visually hidden context text to the repeated ones.', ['2.4.6']),
  'no-main': r('The page has no <main> landmark.', 'Screen reader users jump straight to the main content with a landmark; without it they page through the header and navigation.', 'Wrap the page\'s primary content in a single <main> element.', ['1.3.1', '2.4.1']),
  'multiple-main': r('The page has more than one visible main landmark.', 'The landmark list is ambiguous about which is the page\'s main content.', 'Keep one visible <main>; hide the others with the hidden attribute.', ['1.3.1']),
  'nav-indistinct': r('Several navigation landmarks have no distinct label.', 'The landmark list shows "navigation, navigation" and users cannot tell which is which.', 'Label each with aria-label (for example "Main", "Footer", "Breadcrumb").', ['1.3.1', '2.4.1']),
  'aside-indistinct': r('Several complementary landmarks have no distinct label.', 'The landmark list shows "complementary, complementary" and users cannot tell which is which.', 'Label each <aside> with aria-label or aria-labelledby.', ['1.3.1']),
  'banner-multiple': r('The page has more than one top-level banner (header) landmark.', 'The landmark list is ambiguous about which is the site header.', 'Use one top-level <header>; a <header> inside an article or section is not a banner.', ['1.3.1']),
  'contentinfo-multiple': r('The page has more than one top-level contentinfo (footer) landmark.', 'The landmark list is ambiguous about which is the site footer.', 'Use one top-level <footer>; a <footer> inside an article or section is not a contentinfo landmark.', ['1.3.1']),
  // a11y-structure: names, links, references
  'label-in-name': r('A control\'s accessible name (aria-label) does not contain its visible label.', 'Voice-control users say what they see ("click Search"), and it fails when the hidden name differs.', 'Start the aria-label with the visible text, or drop the aria-label and let the visible text name the control.', ['2.5.3']),
  'http-links': r('A link on an HTTPS page points to a plain HTTP address.', 'The next page loads unencrypted, and browsers may warn or block it.', 'Link to the HTTPS version of the address.'),
  'multi-text': r('The same URL is linked with different link texts.', 'Not an error by itself; inconsistent naming can confuse people who browse a list of links.', 'Use the same text for the same destination where it makes sense.', ['2.4.4']),
  'no-current': r('The link to the current page in a navigation has no aria-current.', 'Screen reader users are not told which page they are on in the menu.', 'Add aria-current="page" to the link for the current page.', ['1.3.1']),
  'label-refs': r('An aria-labelledby, aria-describedby or label for= points to an id that does not exist.', 'The name or help text is silently missing, so the control is announced without it.', 'Fix the id in the reference or add the id to the target element.', ['1.3.1', '4.1.2']),
  'aria-refs': r('An aria-controls, aria-owns or aria-activedescendant points to an id that does not exist.', 'Assistive technology cannot follow the relationship the widget declares.', 'Fix the id, or remove the attribute if the target is not on the page.', ['4.1.2']),
  'bad-alt': r('An image has unhelpful alt text such as "image of", a file name, a number string or a very long description.', 'It adds noise for screen reader users without telling them what the image shows.', 'Describe the purpose of the image in a short phrase; leave out "image of" and file names; use alt="" for decorative images.', ['1.1.1']),
  'bad-autocomplete': r('An autocomplete attribute has a value that is not in the HTML list.', 'Browsers and assistive tools cannot fill the field or show its purpose.', 'Use a standard token such as given-name, email, tel or street-address.', ['1.3.5']),
  'reset-button': r('The form has a Reset button.', 'It is easy to activate by mistake and wipes everything the user entered.', 'Remove it unless users really need it, or ask for confirmation first.'),
  // a11y-structure: size and focus
  'targets-24': r('A clickable target is smaller than 24 by 24 CSS pixels and has other targets close by.', 'People with tremors or large fingers hit the wrong control.', 'Make the target at least 24 by 24 px, or leave 24 px of space around it (padding counts toward the size).', ['2.5.8']),
  'targets-44': r('A touch target is under 44 by 44 CSS pixels (advisory).', 'Small targets on a phone are hard to hit accurately.', 'Aim for 44 by 44 px on touch interfaces.', ['2.5.5']),
  'small-text': r('Text is set from 10 to under 12 px.', 'It is hard to read, and people with low vision need to zoom more.', 'Use at least 12 px, and ideally 16 px for body text; size in rem so it follows the user\'s settings.', ['1.4.4']),
  'small-fields': r('A form field uses text smaller than 16 px.', 'iOS Safari zooms the page in when such a field is focused.', 'Set font-size to at least 16px on form fields.', ['1.4.4']),
  'focus-jumps': r('Tabbing moves focus back up the page (inferred from the DOM).', 'The focus order does not follow the visual or reading order, so keyboard users lose their place.', 'Reorder the DOM to match the visual order instead of repositioning with CSS; avoid positive tabindex.', ['2.4.3']),
  'no-role': r('An element is focusable but has no role.', 'A screen reader announces it with no indication of what it is or does.', 'Use a native element (button, a, input), or add a role and keyboard behaviour. Scrollable regions may take tabindex without a role.', ['4.1.2']),
  'focus-none': r('No sampled control shows a visible focus indicator.', 'Keyboard users cannot see where they are on the page.', 'Do not remove outlines (outline: none) without a replacement; style :focus-visible with a clear outline of at least 2 px and enough contrast.', ['2.4.7']),
  focus: r('This kind of control shows no visible change when it takes focus.', 'Keyboard users cannot see where they are on the page.', 'Do not remove outlines (outline: none) without a replacement; style :focus-visible with a clear outline.', ['2.4.7']),
  'possible-heading': r('Short bold or large text in a <p> or <div>, followed by content, looks like a heading but is not marked up as one.', 'Screen reader users cannot jump to it by heading, and the page outline loses a section.', 'Mark it up as the right heading level (h2 to h6) and style it with CSS. Ignore this if it is not a heading.', ['1.3.1', '2.4.6']),
  'possible-list': r('Three or more lines start with the same bullet or number but are not in a list.', 'A screen reader does not announce a list or its item count, and users cannot move item to item.', 'Use <ul> or <ol> with <li> items, and drop the typed bullets or numbers (CSS list-style provides them).', ['1.3.1']),
  'vague-link': r('Link text such as "click here", "more" or "read more" says nothing about where it goes.', 'Screen reader users often browse a list of links, where every "read more" looks the same.', 'Make the text describe the destination ("Read our returns policy"), or add visually hidden text to it.', ['2.4.4', '2.4.9']),
  'tiny-text': r('Text is rendered smaller than 10 px.', 'It is very hard to read and may be unreadable on a phone.', 'Raise the font size to at least 12 px, and ideally 16 px for body text.', ['1.4.4']),
  'justified-text': r('A long paragraph is justified (text-align: justify).', 'The uneven word spacing creates rivers of white space that are hard to read, especially with dyslexia or low vision.', 'Use text-align: left (or start) for body text.', ['1.4.8']),
  'underline-nonlink': r('Text is underlined but is not a link.', 'Users take underlined text for a link and try to click it.', 'Remove the underline and use bold, italics or colour for emphasis. Keep underlines for links.', ['1.4.1']),
  // keyboard walk
  'kb-trap': r('Pressing Tab keeps returning to the same elements.', 'Keyboard users cannot reach the rest of the page, or leave a widget.', 'Make sure Tab and Shift+Tab can leave every widget; only modal dialogs may hold focus, and they must close with Escape.', ['2.1.2']),
  'kb-focus-lost': r('Tab moved focus to nothing (the page body) between two elements.', 'Keyboard users lose their place and must start again from the top.', 'Do not remove or hide the focused element; move focus to the next sensible element when content is removed.', ['2.4.3']),
  'kb-hidden': r('Focus lands on something hidden or off-screen.', 'Keyboard users cannot see where focus is.', 'Take hidden controls out of the Tab order (display: none, hidden or tabindex="-1"), or reveal them when focused.', ['2.4.7', '2.4.11']),
  'kb-no-name': r('A keyboard stop has no accessible name.', 'A screen reader announces only the role, so users cannot tell what the control does.', 'Give it text, an aria-label, or an alt on the image inside it.', ['4.1.2']),
  'kb-no-focus-style': r('Nothing visible changes when a keyboard stop takes focus.', 'Keyboard users cannot see where they are on the page.', 'Style :focus-visible with an outline of at least 2 px; do not use outline: none without a replacement.', ['2.4.7']),
  'kb-positive-tabindex': r('An element uses a positive tabindex.', 'It is pulled ahead of the page order, so Tab no longer follows the reading order.', 'Use tabindex="0" or none, and order the DOM as users should reach it.', ['2.4.3']),
  'kb-jumps': r('Tab order jumps back up the page (measured on the real walk).', 'Focus order that does not follow the visual order is confusing.', 'Reorder the DOM to match the visual order.', ['2.4.3']),
  'kb-no-skip-link': r('The first Tab stop is not a same-page "skip to content" link.', 'Keyboard users tab through the whole header and menu on every page.', 'Add a skip link as the first focusable element, pointing to the id of <main>; it may stay hidden until focused.', ['2.4.1']),
  'kb-skip-target': r('The skip link\'s target is missing, hidden, or can\'t take focus.', 'Activating the skip link does not move focus, so it does not skip anything.', 'Point the link at an existing visible element (an id on <main>), and give a non-interactive target tabindex="-1".', ['2.4.1']),
  'kb-banner-unreachable': r('A cookie or consent banner is shown on load, but Tab never reaches it.', 'Keyboard users cannot accept, decline or close it, and it may cover content for as long as it stays.', 'Put the banner early in the DOM (or move focus to it on load), and make its buttons real <button> elements.', ['2.1.1', '2.4.3']),
  'kb-banner-trap': r('A cookie banner or dialog open on load holds keyboard focus, but is not marked up as a modal dialog.', 'Sighted keyboard users are stuck in it until they choose; screen reader users are not told the rest of the page is out of reach.', 'If it must hold focus, make it a modal: role="dialog" with aria-modal="true" and a label (or <dialog> opened with showModal()), closable with Escape. Otherwise let Tab leave it.', ['2.1.2', '4.1.2']),
  'kb-banner-modal': r('A cookie banner or dialog open on load holds keyboard focus as a modal dialog.', 'This is correct behaviour for a modal: focus stays inside until the user chooses or closes it.', 'Check that it has a label, that Escape closes it (or a close button is first), and that focus returns to the page afterwards.', ['2.1.2', '2.4.3']),
  'kb-obscured': r('A cookie banner stays on screen and covers keyboard stops while they have focus.', 'Sighted keyboard users tab on behind it and cannot see where focus is.', 'Keep the banner from covering the page (put it in the flow, or leave room for it with scroll-padding), or move focus into it and close it once the user chooses.', ['2.4.11']),
  'kb-obscured-unsure': r('A cookie banner shown as a full-screen frame may cover keyboard stops while they have focus; HARgus cannot see what the frame paints.', 'If the banner covers them, sighted keyboard users tab on behind it and cannot see where focus is.', 'Check by hand with the banner open: tab through the page and watch whether focus disappears behind it. Keep the banner from covering the page, or move focus into it.', ['2.4.11']),
  'kb-confined': r('The keyboard walk stayed inside one container open on load and could not set it aside.', 'The rest of the page was not walked, so its keyboard order is unmeasured; the DOM-inferred checks stand in.', 'Check the page by hand with the dialog closed, or take a new reading after dismissing it.', ['2.1.2']),
  'kb-stopped': r('The keyboard walk stopped before the end of the page (stop cap, time limit or a frame holding focus).', 'Stops after that point were not checked; page-wide order findings come from the DOM checks instead.', 'Very long pages exceed the walk\'s budget; check the rest by hand, or take a reading of a shorter page.', ['2.1.1']),
  'fake-buttons': r('Elements without button semantics (a div or span with a click handler or role="button") act as buttons.', 'They are not focusable or announced as buttons unless the author rebuilds that by hand, so keyboard and screen reader users miss them.', 'Use a real <button>. If you must keep the element, add tabindex="0", role="button" and Enter and Space key handling.', ['2.1.1', '4.1.2']),
  'kb-clickable': r('An element responds to clicks but cannot be reached by keyboard.', 'Keyboard and screen reader users cannot activate it.', 'Use a real <button> or <a href>. If you must keep the element, add tabindex="0", a role, and Enter and Space key handling.', ['2.1.1']),
  // images (the Images and alt text panel)
  'no-name': r('An image-like element (input image, role="img", SVG, area or object) has no accessible name.', 'A screen reader skips it or reads a file name.', 'Add alt (area, input image), aria-label or a <title> (SVG, role="img").', ['1.1.1']),
  'linked-empty-alt': r('An image inside a link has empty alt and the link has no other text.', 'The link has no name; a screen reader announces only the address.', 'Give the image alt text that says where the link goes.', ['1.1.1', '2.4.4']),
  'suspicious-alt': r('The alt text looks like a placeholder: "image", "photo", "spacer", a file name or similar.', 'It tells screen reader users nothing about the image.', 'Replace it with a short description of the image\'s purpose, or alt="" if it is decorative.', ['1.1.1']),
  'redundant-alt': r('The alt text repeats the text next to the image.', 'A screen reader reads the same words twice.', 'Use alt="" when the nearby text already says it.', ['1.1.1']),
  'long-alt': r('The alt text is longer than 100 characters.', 'Long alt text is tedious to hear and cannot be navigated.', 'Shorten the alt to the essential point, and put the long description in the page text or a linked page.', ['1.1.1']),
  'filename-alt': r('The alt text looks like a file name.', 'It tells screen reader users nothing about the image.', 'Describe the image\'s purpose instead.', ['1.1.1']),
  'repeated-alt': r('Different images share the same alt text.', 'Users cannot tell the images apart.', 'Give each image alt text that tells it apart, or alt="" for the decorative ones.', ['1.1.1']),
  'alt-decorative': r('The image has empty alt text, so assistive technology ignores it.', 'This is right for decoration. If the image carries information, it is lost.', 'Check that the image is purely decorative; otherwise add alt text.', ['1.1.1']),
  'alt-ok': r('The image has alt text, shown on the map.', 'Shown so you can check that the alt text reads well in place.', 'Make sure the alt text gives the image\'s purpose, not just what it looks like.', ['1.1.1']),
  // other Page map marks
  contrast: r('Text does not have enough contrast against its background.', 'People with low vision or colour-vision deficiency, or anyone in bright light, cannot read it.', 'Darken the text or lighten the background until the ratio is at least 4.5:1 (3:1 for large text: 18.66 px bold or 24 px).', ['1.4.3']),
  heading: r('A heading on the page, shown with its level.', 'Headings give the page its outline and let screen reader users jump between sections.', 'Check that the level matches the page structure.', ['1.3.1', '2.4.6']),
  landmark: r('A landmark region of the page, shown with its role.', 'Landmarks let screen reader users jump between the regions of the page.', 'Check that each landmark is used once for what it is, and labelled when there are several of one kind.', ['1.3.1', '2.4.1']),
  'kb-stop': r('A stop in the keyboard Tab order, numbered in sequence.', 'The numbers show the order in which Tab visits the controls.', 'Check that the order follows the reading order and that every control you expect is on the path.', ['2.4.3']),
  'kb-banner-stop': r('A stop inside the cookie banner or dialog that held focus on load, numbered B1, B2…', 'Tab visits these first; the page stops are numbered after the banner was set aside.', 'Check that every choice in the banner can be reached and has a clear name.', ['2.1.1', '2.4.3']),
  // contrast and the accessibility views
  'contrast-pair': r('Some text does not have enough contrast against its background.', 'People with low vision or colour-vision deficiency, or anyone in bright light, cannot read it.', 'Darken the text or lighten the background until the ratio is at least 4.5:1 (3:1 for large text).', ['1.4.3']),
  'contrast-unknown': r('The text sits over an image, gradient or layered background, so the contrast could not be measured.', 'The text may be unreadable over parts of the background.', 'Check by eye, and put a solid or semi-opaque background behind text that sits over images.', ['1.4.3']),
  'contrast-apca': r('The colour pair passes WCAG 2 but is below APCA (the proposed WCAG 3 method) thresholds.', 'Advisory only: perceived contrast can be low for thin or small text.', 'Consider a larger size, heavier weight or more contrast.', ['1.4.6']),
  'views-unverified': r('An accessibility view could not be verified.', 'The matching check did not run on this reading.', 'Take a new reading to repeat the check.'),
  'reflow-scroll': r('The page scrolls sideways in a 320 px wide window.', 'People who zoom to 400% (a 320 px window) must scroll in two directions to read lines.', 'Let content reflow to one column: use fluid widths and max-width: 100%, wrap long strings, and keep wide tables and code in their own scrolling container.', ['1.4.10']),
  'reflow-clip': r('Text is clipped in a 320 px wide window.', 'Content is lost when users zoom in.', 'Avoid fixed widths and heights on text containers; use min-height and let text wrap.', ['1.4.10']),
  'spacing-clip': r('Text is clipped when WCAG text spacing is applied.', 'People who need wider line, letter and word spacing lose content.', 'Do not fix the height of text containers; let them grow (min-height, not height) and avoid overflow: hidden on text.', ['1.4.12']),
  'spacing-scroll': r('The page scrolls sideways with WCAG text spacing applied.', 'Wider spacing makes the layout overflow.', 'Let text wrap and use flexible widths.', ['1.4.12']),
  'text200-ignored': r('Body text stays the same size when the browser\'s default font size doubles.', 'People who set a larger default font size do not get it.', 'Size text in rem or em (or %), not px.', ['1.4.4']),
  'text200-clip': r('Text is clipped at 200% size.', 'People who enlarge text lose content.', 'Avoid fixed heights on text containers and use min-height.', ['1.4.4']),
  'text200-scroll': r('The page scrolls sideways at 200% text size.', 'Enlarged text makes the layout overflow.', 'Let text wrap and use flexible widths.', ['1.4.4']),
  'dark-none': r('The page has no dark colour scheme.', 'Advisory: some people with light sensitivity prefer a dark scheme.', 'Support prefers-color-scheme: dark if it suits your design.'),
  'dark-light': r('The page declares a dark color-scheme but stays light.', 'The declaration and the styles disagree, so form controls and scrollbars may clash.', 'Make color-scheme match the styles you actually ship.'),
  'forced-optout': r('Many elements opt out of forced colours (forced-color-adjust: none).', 'Windows High Contrast users get your colours instead of theirs.', 'Remove forced-color-adjust: none, or restrict it to elements that really need their colours.', ['1.4.3']),
  'forced-icons': r('Icon-only controls may vanish in forced colours.', 'Forced colours replace colours but not background images, so a background-image icon can disappear.', 'Use an SVG with fill: currentColor, or visible text.', ['1.4.11']),
  'print-chrome': r('Navigation and site chrome still print.', 'Printing wastes paper on menus and banners, and the content is pushed down the page.', 'Hide navigation, banners and widgets in a @media print block.'),
  'print-overlays': r('Fixed or sticky overlays print over the content.', 'Cookie banners and chat widgets cover text on every printed page.', 'Hide fixed and sticky elements in a @media print block.'),
  'print-none': r('The page has no print styles.', 'Advisory: printing (and printing to PDF) uses the screen layout.', 'Add a @media print block for readable output.'),
  'morecontrast-none': r('The page has no high-contrast styles (prefers-contrast).', 'Advisory: some people ask their system for more contrast.', 'Add a prefers-contrast: more block that raises contrast, if it suits your design.'),
};

const AXE = new Set(['axe', 'axe-review']);

/**
 * The reference for a finding: { what, why, fix, wcag: [{ sc, name, url }], url } or null.
 * `axeTags` are axe's tags for its findings; `extra` is { help, url } from the finding (axe's help text and rule page).
 * A key like "review:color-contrast" is axe's needs-review result for that rule.
 */
export function referenceFor(pluginId, key, axeTags, extra = {}) {
  const id = String(key || '');
  const review = id.startsWith('review:');
  if (AXE.has(pluginId) || review) {
    const rule = review ? id.slice(7) : id;
    return {
      what: extra.help || rule,
      why: review ? 'axe could not decide this automatically, so a person has to look at the element.' : 'axe-core found this against the WCAG rules it tests.',
      fix: review ? 'Check the element by hand against the rule page (linked), which describes what to look for and how to fix it.' : 'Follow the rule page (linked) for the failing checks and the ways to fix them.',
      wcag: wcagFromTags(axeTags).map(wcagLink),
      url: extra.url || '',
    };
  }
  const entry = Object.hasOwn(REFERENCE, id) ? REFERENCE[id] : /^focus-/.test(id) ? REFERENCE.focus : null;
  if (!entry) return null;
  return { what: entry.what, why: entry.why, fix: entry.fix, wcag: entry.wcag.map(wcagLink), url: extra.url || '' };
}

/** The reference for a Page map mark ({ source, ruleId, label, tags, ref }), or null. */
export function referenceForMark(m) {
  if (!m?.ruleId) return null;
  const review = m.source === 'axe-review';
  const axe = review || m.source === 'axe';
  return referenceFor(axe ? 'axe' : m.source, review ? `review:${m.ruleId}` : m.ruleId, m.tags,
    { help: String(m.label || '').replace(/^Needs review: /, ''), url: m.ref });
}

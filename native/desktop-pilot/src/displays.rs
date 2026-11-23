use serde::Serialize;
use std::collections::HashSet;
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Rect { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Display { pub id: usize, pub scale: f64, pub dip: Rect, pub phys: Rect }

pub struct Layout {
    pub generation: u64,
    pub displays: Vec<Display>,
    ready: HashSet<String>,
    windows_ready: bool,
}

impl Layout {
    pub fn new(displays: Vec<Display>) -> Self {
        Self { generation: 0, displays, ready: HashSet::new(), windows_ready: false }
    }

    pub fn label(&self, id: usize) -> String { format!("overlay-{}-{id}", self.generation) }

    pub fn display(&self, label: &str) -> Option<&Display> {
        self.displays.iter().find(|d| self.label(d.id) == label)
    }

    pub fn replace(&mut self, displays: Vec<Display>) {
        self.generation += 1;
        self.displays = displays;
        self.ready.clear();
        self.windows_ready = false;
    }

    pub fn mark_ready(&mut self, label: &str) -> bool {
        if self.display(label).is_none() { return false; }
        self.ready.insert(label.to_owned());
        self.is_ready()
    }

    pub fn is_ready(&self) -> bool {
        self.windows_ready && !self.displays.is_empty() && self.ready.len() == self.displays.len()
    }

    pub fn finish_build(&mut self) { self.windows_ready = true; }
}

#[derive(Debug, PartialEq)]
pub enum DisplayChange { None, Retire, Rebuild, TimedOut }

pub struct DisplayWatch {
    observed: Vec<Display>,
    waiting_since: Duration,
}

impl DisplayWatch {
    pub fn new(displays: Vec<Display>) -> Self {
        Self { observed: displays, waiting_since: Duration::ZERO }
    }

    pub fn update(&mut self, current: &[Display], layout: &Layout, now: Duration) -> DisplayChange {
        if current != self.observed {
            self.observed = current.to_vec();
            self.waiting_since = now;
            return DisplayChange::Retire;
        }
        if layout.displays != current {
            self.waiting_since = now;
            return DisplayChange::Rebuild;
        }
        if layout.is_ready() || layout.displays.is_empty() {
            self.waiting_since = now;
        } else if now.saturating_sub(self.waiting_since) > Duration::from_secs(15) {
            return DisplayChange::TimedOut;
        }
        DisplayChange::None
    }
}

fn overlaps(a: &Rect, b: &Rect) -> bool {
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

pub fn parked_bounds(d: &Display, displays: &[Display]) -> Option<Rect> {
    let mut bounds = d.phys.clone();
    bounds.height -= d.scale;
    let candidates = [Rect { y: d.phys.y - bounds.height + d.scale, ..bounds.clone() },
        Rect { y: d.phys.y + d.phys.height - d.scale, ..bounds.clone() },
        Rect { x: d.phys.x - bounds.width + d.scale, ..bounds.clone() },
        Rect { x: d.phys.x + d.phys.width - d.scale, ..bounds }];
    candidates.into_iter().find(|r| !displays.iter().any(|o| o.id != d.id && overlaps(r, &o.phys)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(id: usize, x: f64, scale: f64) -> Display {
        let phys = Rect { x, y: 0.0, width: 1920.0, height: 1080.0 };
        Display { id, scale, dip: Rect { x: x / scale, y: 0.0, width: 1920.0 / scale, height: 1080.0 / scale }, phys }
    }

    #[test]
    fn waits_for_every_current_renderer_and_rejects_retired_labels() {
        let mut layout = Layout::new(vec![display(0, 0.0, 1.0), display(1, -1920.0, 1.5)]);
        layout.finish_build();
        assert!(!layout.mark_ready("overlay-0-0"));
        assert!(!layout.mark_ready("overlay-0-0"));
        assert!(layout.mark_ready("overlay-0-1"));
        layout.replace(vec![display(0, -1920.0, 2.0)]);
        assert!(!layout.is_ready());
        assert!(!layout.mark_ready("overlay-0-0"));
        assert!(layout.display("overlay-0-1").is_none());
        layout.finish_build();
        assert!(layout.mark_ready("overlay-1-0"));
        assert_eq!(layout.display("overlay-1-0").unwrap().scale, 2.0);
    }

    #[test]
    fn handles_no_displays_until_a_monitor_returns() {
        let mut layout = Layout::new(vec![display(0, 0.0, 1.0)]);
        layout.replace(vec![]);
        assert!(!layout.is_ready());
        assert!(!layout.mark_ready("overlay-1-0"));
        layout.replace(vec![display(0, 0.0, 1.25)]);
        layout.finish_build();
        assert!(layout.mark_ready("overlay-2-0"));
    }

    #[test]
    fn waits_for_native_window_placement_even_if_renderers_are_already_ready() {
        let mut layout = Layout::new(vec![display(0, 0.0, 1.0)]);
        assert!(!layout.mark_ready("overlay-0-0"));
        layout.finish_build();
        assert!(layout.is_ready());
        layout.replace(vec![display(0, 0.0, 1.5)]);
        assert!(!layout.mark_ready("overlay-1-0"));
        layout.finish_build();
        assert!(layout.is_ready());
    }

    #[test]
    fn retires_stale_overlays_before_rebuilding_a_stable_layout() {
        let original = vec![display(0, 0.0, 1.0)];
        let mut resized = original.clone();
        resized[0].phys.width = 2560.0;
        let changes = [vec![display(0, 0.0, 1.5)], vec![display(0, -1920.0, 1.0)], resized,
            vec![display(0, 0.0, 1.0), display(1, -1920.0, 1.0)]];
        for current in changes {
            let mut layout = Layout::new(original.clone());
            let mut watch = DisplayWatch::new(original.clone());
            assert_eq!(watch.update(&current, &layout, Duration::from_secs(1)), DisplayChange::Retire);
            layout.replace(vec![]);
            assert_eq!(watch.update(&current, &layout, Duration::from_secs(2)), DisplayChange::Rebuild);
            layout.replace(current.clone());
            layout.finish_build();
            assert_eq!(watch.update(&current, &layout, Duration::from_secs(3)), DisplayChange::None);
            assert_eq!(watch.update(&current, &layout, Duration::from_secs(18)), DisplayChange::TimedOut);
            for d in &current { layout.mark_ready(&layout.label(d.id)); }
            assert_eq!(watch.update(&current, &layout, Duration::from_secs(19)), DisplayChange::None);
        }
    }

    #[test]
    fn waits_through_transient_changes_and_rebuilds_even_when_the_original_layout_returns() {
        let original = vec![display(0, 0.0, 1.0)];
        let mut layout = Layout::new(original.clone());
        let mut watch = DisplayWatch::new(original.clone());
        assert_eq!(watch.update(&[], &layout, Duration::from_secs(1)), DisplayChange::Retire);
        layout.replace(vec![]);
        assert_eq!(watch.update(&[], &layout, Duration::from_secs(30)), DisplayChange::None);
        assert_eq!(watch.update(&original, &layout, Duration::from_secs(31)), DisplayChange::Retire);
        assert_eq!(watch.update(&original, &layout, Duration::from_secs(32)), DisplayChange::Rebuild);
    }

    #[test]
    fn parks_on_a_free_edge_using_the_current_scale_and_neighbours() {
        let d = display(0, -1920.0, 2.0);
        let mut above = display(1, -1920.0, 1.0);
        above.phys.y = -1080.0;
        let parked = parked_bounds(&d, &[d.clone(), above.clone()]).unwrap();
        assert_eq!(parked.y, 1078.0);
        assert_eq!(parked.height, 1078.0);
        assert!(!overlaps(&parked, &above.phys));
        let mut below = above.clone(); below.id = 2; below.phys.y = 1080.0;
        let mut left = display(3, -3840.0, 1.0); left.phys.height = 3240.0; left.phys.y = -1080.0;
        let mut right = display(4, 0.0, 1.0); right.phys.height = 3240.0; right.phys.y = -1080.0;
        assert!(parked_bounds(&d, &[d.clone(), above, below, left, right]).is_none());
    }
}

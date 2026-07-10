import { checkpointHasIssue, getReviewMetrics, type Area } from '@/types';

type StatusMetrics = {
  total: number;
  ok: number;
  issues: number;
};

export type InspectionItemMetrics = {
  stats: StatusMetrics;
  pending: number;
  photoCount: number;
  commentCount: number;
};

export type InspectionLocationMetrics = {
  stats: StatusMetrics;
  pending: number;
  progress: number;
  photoCount: number;
  commentCount: number;
};

export type InspectionAreaMetrics = {
  stats: StatusMetrics;
  pending: number;
  reviewedPercent: number;
  okPercent: number;
  issuePercent: number;
  locationMetrics: Map<string, InspectionLocationMetrics>;
  itemMetrics: Map<string, InspectionItemMetrics>;
};

export function getInspectionAreaMetrics(
  locations: Area['locations']
): InspectionAreaMetrics {
  const locationMetrics = new Map<string, InspectionLocationMetrics>();
  const itemMetrics = new Map<string, InspectionItemMetrics>();

  let total = 0;
  let ok = 0;
  let issues = 0;

  for (const location of locations) {
    let locationTotal = 0;
    let locationOk = 0;
    let locationIssues = 0;
    let locationPhotoCount = 0;
    let locationCommentCount = 0;

    for (const item of location.items) {
      let itemTotal = 0;
      let itemOk = 0;
      let itemIssues = 0;
      let itemPhotoCount = 0;
      let itemCommentCount = 0;

      for (const checkpoint of item.checkpoints) {
        itemTotal += 1;
        if (checkpoint.status === 'ok') itemOk += 1;
        else if (checkpointHasIssue(checkpoint)) itemIssues += 1;
        itemPhotoCount += checkpoint.photos.length;
        if (checkpoint.comments.trim()) itemCommentCount += 1;
      }

      const itemPending = itemTotal - itemOk - itemIssues;
      itemMetrics.set(item.id, {
        stats: { total: itemTotal, ok: itemOk, issues: itemIssues },
        pending: itemPending,
        photoCount: itemPhotoCount,
        commentCount: itemCommentCount,
      });

      locationTotal += itemTotal;
      locationOk += itemOk;
      locationIssues += itemIssues;
      locationPhotoCount += itemPhotoCount;
      locationCommentCount += itemCommentCount;
    }

    const locationReviewMetrics = getReviewMetrics(locationTotal, locationOk, locationIssues);
    locationMetrics.set(location.id, {
      stats: { total: locationTotal, ok: locationOk, issues: locationIssues },
      pending: locationReviewMetrics.pending,
      progress: locationReviewMetrics.reviewedPercent,
      photoCount: locationPhotoCount,
      commentCount: locationCommentCount,
    });

    total += locationTotal;
    ok += locationOk;
    issues += locationIssues;
  }

  const reviewMetrics = getReviewMetrics(total, ok, issues);
  return {
    stats: { total, ok, issues },
    pending: reviewMetrics.pending,
    reviewedPercent: reviewMetrics.reviewedPercent,
    okPercent: reviewMetrics.okPercent,
    issuePercent: reviewMetrics.issuePercent,
    locationMetrics,
    itemMetrics,
  };
}

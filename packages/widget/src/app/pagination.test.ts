import assert from 'node:assert/strict'
import test from 'node:test'
import { clampPage, pageAfterResize, pageCapacity, paginationWindow, totalPages } from './pagination.ts'

test('capacity is columns × rows, clamped to the API limit', () => {
  assert.equal(pageCapacity(9, 2), 18)
  assert.equal(pageCapacity(12, 2), 24)
  assert.equal(pageCapacity(2, 2), 4)
  assert.equal(pageCapacity(0, 0), 1)
  assert.equal(pageCapacity(80, 5), 100)
})

test('page count never returns a negative or fractional page', () => {
  assert.equal(totalPages(0, 18), 0)
  assert.equal(totalPages(57, 18), 4)
  assert.equal(totalPages(36, 18), 2)
  assert.equal(totalPages(1, 0), 1)
})

test('clampPage keeps the page inside the rendered range', () => {
  assert.equal(clampPage(0, 4), 1)
  assert.equal(clampPage(9, 4), 4)
  assert.equal(clampPage(3, 0), 1)
  assert.equal(clampPage(2, 4), 2)
})

test('resize keeps the first visible item on screen', () => {
  // page 2 at 18/page starts at item 18; at 24/page that is still page 1.
  assert.equal(pageAfterResize(2, 18, 24), 1)
  // page 3 at 18/page starts at 36; at 12/page that is page 4.
  assert.equal(pageAfterResize(3, 18, 12), 4)
  assert.equal(pageAfterResize(1, 18, 9), 1)
})

test('pagination window stays short and contains the current page', () => {
  assert.deepEqual(paginationWindow(1, 3), [1, 2, 3])
  assert.deepEqual(paginationWindow(1, 10), [1, 2, 3, 4, 5, '…', 10])
  assert.deepEqual(paginationWindow(6, 10), [1, '…', 5, 6, 7, '…', 10])
  assert.deepEqual(paginationWindow(10, 10), [1, '…', 6, 7, 8, 9, 10])
  assert.deepEqual(paginationWindow(1, 0), [])
})

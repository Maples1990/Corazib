(async function loadPosts() {
  const container = document.getElementById('blog-posts');
  const placeholder = document.getElementById('blog-placeholder');
  try {
    const res = await fetch('/api/posts', { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.ok || !data.posts || data.posts.length === 0) {
      placeholder.hidden = false;
      return;
    }
    container.innerHTML = data.posts.map(function(post) {
      var date = new Date(post.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      var paragraphs = post.body.split('\n').filter(Boolean).map(function(p) {
        return '<p>' + p.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</p>';
      }).join('');
      return '<article class="blog-post"><time>' + date + '</time><h2>' +
        post.title.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') +
        '</h2>' + paragraphs + '</article>';
    }).join('');
  } catch (_e) {
    placeholder.hidden = false;
  }
})();

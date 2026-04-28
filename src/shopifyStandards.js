export const SHOPIFY_STANDARDS = {
  homePage: {
    heroSection: {
      standard: "Hero section should be above the fold with clear value proposition and CTA",
      reference: "Shopify Theme Guidelines - Homepage Layout",
      impact: "High - First impression drives conversion"
    },
    headerNavigation: {
      standard: "Sticky header with clear navigation, search, and cart icon",
      reference: "Shopify UX Patterns - Navigation",
      impact: "High - Navigation affects user experience"
    },
    trustSignals: {
      standard: "Trust badges, reviews, or guarantees visible above the fold",
      reference: "Shopify Conversion Best Practices",
      impact: "Medium - Builds credibility and reduces bounce"
    },
    announcementBar: {
      standard: "Optional announcement bar with clear, non-intrusive messaging",
      reference: "Shopify Theme Guidelines - Header Components",
      impact: "Low - Can highlight promotions or important info"
    },
    featuredCollections: {
      standard: "Clear collection navigation with hover states and descriptions",
      reference: "Shopify Merchandising Standards",
      impact: "Medium - Guides users to product discovery"
    },
    socialProof: {
      standard: "Customer reviews, testimonials, or social media integration",
      reference: "Shopify Trust & Credibility Guidelines",
      impact: "High - Social proof drives purchases"
    },
    mobileOptimization: {
      standard: "Fully responsive design with touch-friendly elements",
      reference: "Shopify Mobile UX Standards",
      impact: "High - Mobile commerce is critical"
    },
    loadingSpeed: {
      standard: "Page load under 3 seconds, optimized images and assets",
      reference: "Shopify Performance Guidelines",
      impact: "High - Speed affects conversion and SEO"
    },
    accessibility: {
      standard: "WCAG AA compliance, alt text, keyboard navigation",
      reference: "Shopify Accessibility Standards",
      impact: "Medium - Legal requirement and user experience"
    }
  },
  collectionPage: {
    filtering: {
      standard: "Functional filter and sort options with clear labels",
      reference: "Shopify Collection Page Standards",
      impact: "High - Users need to find products easily"
    },
    productGrid: {
      standard: "Consistent product cards with images, titles, and prices",
      reference: "Shopify Product Display Guidelines",
      impact: "Medium - Visual consistency improves trust"
    },
    pagination: {
      standard: "Clear pagination or infinite scroll with loading states",
      reference: "Shopify UX Patterns - Lists",
      impact: "Low - Prevents user frustration"
    },
    breadcrumbs: {
      standard: "Clear breadcrumb navigation showing current location",
      reference: "Shopify Navigation Standards",
      impact: "Low - Improves user orientation"
    },
    sorting: {
      standard: "Multiple sort options (price, popularity, newest)",
      reference: "Shopify Collection Standards",
      impact: "Medium - Users have different shopping preferences"
    },
    emptyState: {
      standard: "Helpful empty state when no products match filters",
      reference: "Shopify UX Patterns - Empty States",
      impact: "Low - Guides users when filters are too restrictive"
    }
  },
  productPage: {
    imageGallery: {
      standard: "High-quality product images with zoom functionality",
      reference: "Shopify Product Page Guidelines",
      impact: "High - Visual product presentation drives sales"
    },
    pricing: {
      standard: "Clear pricing with sale indicators and currency formatting",
      reference: "Shopify Pricing Display Standards",
      impact: "High - Price transparency is critical"
    },
    addToCart: {
      standard: "Prominent, accessible add to cart button with clear messaging",
      reference: "Shopify Conversion Optimization",
      impact: "High - Primary conversion action"
    },
    productDescription: {
      standard: "Detailed, scannable product information with specifications",
      reference: "Shopify Product Content Guidelines",
      impact: "Medium - Helps customers make informed decisions"
    },
    reviews: {
      standard: "Integrated review system with star ratings and comments",
      reference: "Shopify Trust Building Standards",
      impact: "High - Reviews influence purchase decisions"
    },
    relatedProducts: {
      standard: "Smart product recommendations and cross-sells",
      reference: "Shopify Merchandising Best Practices",
      impact: "Medium - Increases average order value"
    },
    inventory: {
      standard: "Clear stock indicators and low stock warnings",
      reference: "Shopify Inventory Display Standards",
      impact: "Medium - Manages customer expectations"
    },
    shipping: {
      standard: "Shipping cost calculator and delivery information",
      reference: "Shopify Checkout Transparency",
      impact: "High - Shipping concerns cause cart abandonment"
    }
  },
  seo: {
    metaTitle: {
      standard: "Unique, descriptive title tags under 60 characters",
      reference: "Shopify SEO Best Practices",
      impact: "High - Affects search visibility"
    },
    metaDescription: {
      standard: "Compelling descriptions under 160 characters",
      reference: "Shopify SEO Guidelines",
      impact: "Medium - Influences click-through rates"
    },
    structuredData: {
      standard: "Product and organization schema markup",
      reference: "Shopify Technical SEO Standards",
      impact: "Medium - Enhances search result appearance"
    },
    urlStructure: {
      standard: "Clean, descriptive URLs with proper hierarchy",
      reference: "Shopify URL Structure Guidelines",
      impact: "Low - Improves crawlability and user experience"
    },
    headingStructure: {
      standard: "Proper H1-H6 hierarchy with descriptive headings",
      reference: "Shopify Content Structure Standards",
      impact: "Medium - Improves content readability and SEO"
    }
  },
  technical: {
    coreWebVitals: {
      standard: "Lighthouse scores above 90 for performance, accessibility, SEO",
      reference: "Shopify Performance Standards",
      impact: "High - Affects search rankings and user experience"
    },
    mobileResponsiveness: {
      standard: "Perfect mobile experience across all devices",
      reference: "Shopify Mobile Standards",
      impact: "High - Mobile commerce drives revenue"
    },
    security: {
      standard: "HTTPS, secure payment processing, data protection",
      reference: "Shopify Security Guidelines",
      impact: "High - Customer trust and legal compliance"
    },
    appIntegration: {
      standard: "Clean app integration without theme conflicts",
      reference: "Shopify App Development Standards",
      impact: "Medium - Prevents technical issues"
    },
    themeUpdates: {
      standard: "Regular theme updates and compatibility maintenance",
      reference: "Shopify Theme Maintenance Guidelines",
      impact: "Medium - Ensures security and feature access"
    }
  }
};

export function getShopifyStandard(category, item) {
  return SHOPIFY_STANDARDS[category]?.[item] || null;
}

export function getShopifyReference(category, item) {
  const standard = getShopifyStandard(category, item);
  return standard ? standard.reference : "Shopify Best Practices";
}